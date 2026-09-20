# Testnet runbook — deploying the fixed `execute_order` and proving it on chain

This is the P0-2 fix from `docs/HACKATHON_READINESS.md`, ready to ship. The contract
change is done and tested in code; **the deploy has to run from a machine with network
access to Stellar testnet** (the assistant's sandbox is egress-restricted, so it could not
broadcast). Everything below is copy-paste.

One command does all of it:

```bash
chmod +x scripts/deploy_and_verify.sh
./scripts/deploy_and_verify.sh
```

The sections below are the same steps by hand, plus what to do when one fails.

---

## 1. What changed in the contract, and why

`execute_order` used to do this:

```rust
token_in_client.transfer(&vault, &router, &order.amount_in);   // pre-fund the router
router_client.swap_exact_tokens_for_tokens(…, &vault, &deadline);
```

The real `SoroswapRouter` never takes custody. It does:

```rust
to.require_auth();
TokenClient::new(&e, &path.get(0).unwrap()).transfer(&to, &pair, &amounts.get(0).unwrap());
```

— it **pulls** the input out of `to` (the vault) and into the **pair**. So the old code paid
twice: once to the router, where the funds simply sat, and once more from a balance the
vault no longer had. And that second transfer happens one frame below the vault's own call,
where an invoker's authorization is not implied, so it would have failed even with the
balance present.

The fix, in `contracts/vault/src/lib.rs`:

1. the pre-transfer is gone;
2. the vault asks the router which pool will receive the input
   (`router_pair_for`) and authorizes exactly that nested transfer:

```rust
env.authorize_as_current_contract(vec![
    &env,
    InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: order.token_in.clone(),
            fn_name: Symbol::new(&env, "transfer"),
            args: (vault.clone(), pair, order.amount_in).into_val(&env),
        },
        sub_invocations: vec![&env],
    }),
]);
```

3. after the swap the vault asserts the input actually left exactly once
   (`Error::InputNotSpent`, new) **and** that the realized `token_out` balance delta covers
   `min_user_out` (`Error::SlippageExceeded`, unchanged).

The authorization is scoped to one token, one recipient and one amount, and carries no
sub-invocations of its own. A wrong pool address cannot redirect anything: the router
computes the real recipient, the entry fails to match, and the whole transaction reverts.

### Why the old tests did not catch it

Every execution test ran under `env.mock_all_auths()`, which satisfies *any* `require_auth`
— including the vault's signature on the router's nested transfer. And `MockRouter` paid out
of its own pre-minted balance instead of pulling, so the missing authorization never came
up. Both are fixed in `contracts/vault/src/test.rs`:

* `PullingRouter` now behaves like the real router: `to.require_auth()`, pull into the pair,
  then pay out.
* `test_execute_order_authorizes_router_pull_with_scoped_auth` mocks **only** the keeper's
  top-level call via `mock_auths`, so the nested transfer succeeds only if the contract
  issued the invoker entry itself. Revert the `lib.rs` change and this test fails — that is
  the point of it.
* `test_rejects_router_that_does_not_take_the_input` covers the new `InputNotSpent` guard.

---

## 2. Prerequisites

```bash
brew install stellar-cli          # or: cargo install --locked stellar-cli
rustup target add wasm32-unknown-unknown
stellar --version
```

## 3. Test, build, deploy

```bash
cd contracts/vault && cargo test && cd -            # 11 tests, all must pass

stellar keys generate --global trigger-deployer --network testnet --fund
ACCOUNT=$(stellar keys address trigger-deployer)

cd contracts/vault && stellar contract build && cd -
WASM=$(find contracts/vault/target -name 'trigger_vault.wasm' -path '*release*' | head -1)

VAULT_ID=$(stellar contract deploy --wasm "$WASM" --source trigger-deployer --network testnet)
echo "$VAULT_ID"
```

## 4. Point it at the real Soroswap router

Published testnet addresses (`soroswap/core → public/testnet.contracts.json`):

| Contract | Address |
| --- | --- |
| Router | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| Factory | `CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY` |

⚠️ Verify these are still current before the demo — if Soroswap redeployed, the script's
defaults are stale and `router_pair_for` will fail.

```bash
ROUTER=CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD

stellar contract invoke --id "$VAULT_ID" --source trigger-deployer --network testnet \
  -- init --admin "$ACCOUNT" --router "$ROUTER"

# already deployed earlier? just re-point it:
# stellar contract invoke --id "$VAULT_ID" --source trigger-deployer --network testnet \
#   -- set_router --router "$ROUTER"
```

## 5. Find a pool — or make one

```bash
XLM=$(stellar contract id asset --asset native --network testnet)

# does a pool exist for the pair you want?
stellar contract invoke --id "$ROUTER" --source trigger-deployer --network testnet --send=no \
  -- router_pair_for --token_a "$XLM" --token_b "$TOKEN_OUT"

# what will the swap actually return?
stellar contract invoke --id "$ROUTER" --source trigger-deployer --network testnet --send=no \
  -- router_get_amounts_out --amount_in 100000000 --path "[\"$XLM\",\"$TOKEN_OUT\"]"
```

**If no pool has liquidity**, bootstrap your own — still the real Soroswap factory, router
and pair contracts, so the integration stays genuine:

```bash
# a token you control, wrapped as a SAC
stellar contract asset deploy --asset DEMO:$ACCOUNT --network testnet --source trigger-deployer
DEMO=$(stellar contract id asset --asset DEMO:$ACCOUNT --network testnet)

stellar contract invoke --id "$ROUTER" --source trigger-deployer --network testnet \
  -- add_liquidity --token_a "$XLM" --token_b "$DEMO" \
     --amount_a_desired 1000000000 --amount_b_desired 1000000000 \
     --amount_a_min 0 --amount_b_min 0 --to "$ACCOUNT" \
     --deadline $(( $(date +%s) + 600 ))
```

(The issuing account must hold `DEMO` first — pay yourself from the issuer, or use two
accounts. `add_liquidity` creates the pair through the factory if it does not exist.)

## 6. Prove it: one real execution

```bash
MIN_OUT=<95% of the quote from step 5>

stellar contract invoke --id "$VAULT_ID" --source trigger-deployer --network testnet \
  -- create_order --owner "$ACCOUNT" --token_in "$XLM" --token_out "$TOKEN_OUT" \
     --amount_in 100000000 --min_user_out "$MIN_OUT" --fee_bps 100

stellar contract invoke --id "$VAULT_ID" --source trigger-deployer --network testnet \
  -- execute_order --order_id 1 --executor "$ACCOUNT"

stellar contract invoke --id "$VAULT_ID" --source trigger-deployer --network testnet --send=no \
  -- get_order --order_id 1        # → status: Executed
```

Then open `https://stellar.expert/explorer/testnet/contract/$VAULT_ID` and check the
`execute_order` invocation shows **sub-invocations** into the router, the pair and both
token contracts. Before this fix the contract had 15 invocations and **zero**
sub-invocations — that number going up is the evidence the jury asked for.

## 7. Wire the new id into the app

```bash
cat > frontend/.env.local <<EOF
VITE_VAULT_CONTRACT_ID=$VAULT_ID
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_TOKEN_OUT_CONTRACT_ID=$TOKEN_OUT
EOF

# keeper/.env and keeper/.env.example → VAULT_CONTRACT_ID="$VAULT_ID"
# frontend/src/App.tsx → replace the hardcoded fallback id (the script does this for you)
```

Record in the README: **contract id, execution tx hash, router address, pair address.**

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `UnexpectedSize` / decode error on `router_pair_for` | The router address is wrong or Soroswap redeployed | Re-check `public/testnet.contracts.json`, then `set_router` |
| Execution fails with an auth error | The pool the router used differs from the one authorized — usually a stale router/factory pair | Verify `router_pair_for` returns the same pair the explorer shows for the swap |
| `Error(Contract, #11)` — `InputNotSpent` | The router returned without taking the input (wrong router, or a non-Soroswap contract) | Confirm `get_router` points at the Soroswap router |
| `Error(Contract, #6)` — `SlippageExceeded` | Price moved, or `min_user_out` set from a stale quote | Re-quote with `router_get_amounts_out` and use ~95% of it |
| `InsufficientOutputAmount` from the router | The router's own limit check fired first | Same fix — lower `min_user_out` |
| `cargo test` fails to resolve `soroban-sdk` | Offline / no registry access | Run it on a networked machine; the crate must be fetched once |
| `stellar contract build` cannot find the target | `wasm32-unknown-unknown` not installed | `rustup target add wasm32-unknown-unknown` |
| Trustline error on `create_order` with a classic asset | The account holding the asset needs a trustline | `stellar tx new change-trust …`, or use XLM |

## 9. Still open after this

* The contract is redeployed, so the **old vault `CDERIBD7…` keeps the old orders**. Say in
  the README which id is current; do not leave both live in the UI.
* `docs/SECURITY.md` §3.1 still describes the pre-fix `env.invoke_contract` flow and needs
  rewriting against the new one (and it still contains the corrupted control characters).
* `docs/ARCHITECTURE.md` should gain the Mermaid diagram and the new execution sequence.
* The anchor rail (`docs/ANCHOR_INTEGRATION.md`) is still the highest-weight missing piece.
