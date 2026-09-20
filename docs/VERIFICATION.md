# Verification record

Every figure on this page was decoded from a transaction's `TransactionMeta` through
Soroban RPC, or read back from the contract — not taken from the UI. Linked from the
[README](../README.md#what-is-verified).

**Scope note.** V2 limit orders have completed live executions. V3 stop-loss is deployed
and tested but **no real price fall has driven a trigger through to a settlement**. The two
are kept apart on purpose.

---

## 1. V2 — limit orders (live executions)

### 1.1 Deployment and first settlement

| Step | Transaction |
| --- | --- |
| SEP-6 deposit — anchor pays out 61.1895780 USDC | [`65434cdf…411d66`](https://stellar.expert/explorer/testnet/tx/65434cdf31f19aa23d6408da4c3b6bf32587f3a169fadfa4088e44bbdb411d66) |
| WASM upload — `d9ad61c2…10142c` | [`4c7caedb…f67d5d`](https://stellar.expert/explorer/testnet/tx/4c7caedb946665fd72275ba4b2da4b70e709f2f9ff7c9c05b144c403e1f67d5d) |
| Contract deployment | [`b89acbde…e049f0`](https://stellar.expert/explorer/testnet/tx/b89acbde43a36151551139de7f9629a8763a8f91ac8bd4ac2abd903c15e049f0) |
| `init` — admin + Soroswap router | [`3dbdbdce…2343a5`](https://stellar.expert/explorer/testnet/tx/3dbdbdce447fc153728760dbc78a6760512ae5534c9571f28afec62c652343a5) |
| `create_order` — 10 XLM escrowed, net floor 1.0008955 USDC, 100 bps bounty | [`b259cb51…8f4f82`](https://stellar.expert/explorer/testnet/tx/b259cb518287aca4e13efc1390cb24c4639c5cec0ffbaea4b4c50b70e18f4f82) |
| `execute_order` — real Soroswap fill, 1.0535743 USDC realised | [`3b2e80ce…2080ef`](https://stellar.expert/explorer/testnet/tx/3b2e80cef75ab2381ffef82c7421f1e43bd132fbc62740746c7b5a4c612080ef) |

**`3b2e80ce…` decoded from its contract events, in order:**

| Event | Amount | Meaning |
| --- | --- | --- |
| `transfer` XLM — vault → Soroswap pair | `100000000` (10.0000000) | The router **pulled** the input under a scoped sub-invocation. The vault never approved a blanket allowance. |
| `transfer` USDC — Soroswap pair → vault | `10535743` (1.0535743) | The fill arrives at the vault, not at the user. |
| `SoroswapPair` `sync` / `swap` | `amount_1_in 100000000`, `amount_0_out 10535743` | A real pool — [`CCBX3NZT…`](https://stellar.expert/explorer/testnet/contract/CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS), not a mock. |
| `SoroswapRouter` `swap` | `path [XLM SAC, USDC SAC]` | Emitted by [`CCJUD55A…`](https://stellar.expert/explorer/testnet/contract/CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD), the published Soroswap testnet router. |
| `transfer` USDC — vault → executor | `105357` (0.0105357) | Keeper bounty: 100 bps of the **observed delta**. |
| `transfer` USDC — vault → owner | `10430386` (1.0430386) | Net proceeds to the order's owner. |
| `order` `execute` | `(1, executor, 10535743, 105357)` | The vault's own receipt: order id, who executed, gross realised, bounty paid. |

`105357 + 10430386 = 10535743` — the two payouts reconcile exactly against the balance
delta the contract measured. The order's floor was **1.0008955 USDC net**, and the owner
received 1.0430386: the guarantee is checked against the figure that actually reached the
wallet, not against the swap output the bounty is later carved from. The order's on-chain
`status` is now `Executed`.

> **Read honestly:** in this transaction the executor and the owner are the same account,
> because the order was created and settled by the same key while proving the deployment.
> The bounty is a real, separate transfer computed by the contract — but a distinct keeper
> address would make the split visually obvious. **This is not evidence of independent
> keeper automation.** `keeper/` runs the same `execute_order` call with its own key; that
> path has not been exercised against these orders.

### 1.2 Both lifecycles, driven from the deployed app

The settlement above was signed from the command line. These two orders were placed and
closed entirely through <https://lumaflovv.vercel.app> — the form, the **Execute** button
and the **Cancel** button — by a Freighter wallet, `GAJGMHHG…OSSLR`. Both live on **V2**, so
their minimum is a **net** floor: `min_user_out` is what must reach the wallet *after* the
keeper bounty.

| Order | Step | Transaction |
| --- | --- | --- |
| `CAVF2IT2…WP2INT:2` | `create_order` — 10 XLM escrowed, net floor 1.0100000 USDC, 100 bps bounty | [`32252915…cd040b`](https://stellar.expert/explorer/testnet/tx/32252915c3f6028dc4faa4e275a3fac1f1b5c07badb398571177736a7ccd040b) |
| `CAVF2IT2…WP2INT:2` | `execute_order` — real Soroswap fill, 1.0535845 USDC realised | [`2d876f45…b39338`](https://stellar.expert/explorer/testnet/tx/2d876f454743e949d67bd2c38a5d6f63507e224581f6ea74c3ed27037fb39338) |
| `CAVF2IT2…WP2INT:3` | `create_order` — 10 XLM escrowed, identical terms | [`e6b68d4d…bf0513`](https://stellar.expert/explorer/testnet/tx/e6b68d4dee0d622c179ef6af33fc89b369bef3d6bd300a8797b9ece6f6bf0513) |
| `CAVF2IT2…WP2INT:3` | `cancel_order` — 10.0000000 XLM returned | [`e395ebd3…ae5aa8`](https://stellar.expert/explorer/testnet/tx/e395ebd34d8236b11b8db50dc96f1304dae9ccb8c5601a6c1ef17ca0e1ae5aa8) |

Order ids are written `contractId:orderId` because ids restart at 1 in every deployment —
`#2` names three different orders across V0, V1 and V2. Order `#3` carries the same terms
as `#2` and was created 45 seconds later, at the next account sequence number — so the
second transaction was built after the first had already been confirmed, not alongside it.
What prompted that second submission was not established. Rather than leave it resting, it
became the cancellation test.

**`2d876f45…` — execute, decoded from its contract events:**

| Event | Amount | Meaning |
| --- | --- | --- |
| `transfer` XLM — vault → Soroswap pair | `100000000` (10.0000000) | The router pulled the collateral under the scoped sub-invocation. |
| `transfer` USDC — Soroswap pair → vault | `10535845` (1.0535845) | Gross realised, measured by the vault as its own balance delta. |
| `SoroswapPair` `sync` / `swap` | `amount_1_in 100000000`, `amount_0_out 10535845` | The same real pool [`CCBX3NZT…`](https://stellar.expert/explorer/testnet/contract/CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS). |
| `transfer` USDC — vault → executor | `105358` (0.0105358) | Keeper bounty, 100 bps of the observed delta. |
| `transfer` USDC — vault → owner | `10430487` (1.0430487) | Net proceeds to the order's owner. |
| `order` `execute` | `(2, executor, 10535845, 105358)` | The vault's receipt, naming the bounty separately. |

`105358 + 10430487 = 10535845` — the two payouts reconcile exactly against the gross the
contract measured. The floor was **1.0100000 USDC net** and the owner received
**1.0430487**, so `1.0430487 ≥ 1.0100000` held on the figure that actually reached the
wallet. Network fee, charged separately from either payout: 41 092 stroops (0.0041092 XLM).
`get_order(2).status` is now `Executed`.

> **Read honestly, again:** the wallet that owned order `#2` is the wallet that pressed
> **Execute**, so both transfers above landed in the same account and its USDC balance rose
> by the gross 1.0535845. That total is *not* the net payout. The bounty and the net are two
> separate `transfer` events, computed separately by the contract, and only the second is
> what `min_user_out` guards.

**`e395ebd3…` — cancel, decoded the same way:**

| Event | Amount | Meaning |
| --- | --- | --- |
| `transfer` XLM — vault → owner | `100000000` (10.0000000) | The full collateral, returned to the owner's wallet. |
| `order` `cancel` | `3` | The order's receipt. |

The refund is the escrowed amount to the stroop — `100000000` in, `100000000` back — and
`get_order(3).status` is now `Cancelled`. The 16 177 stroops (0.0016177 XLM) of network fee
were charged to the account as a separate ledger entry, not deducted from the refund: this
is why the refund is read from the `transfer` event rather than from the wallet's balance
delta. No swap is attempted on a cancellation, so the bounty and the floor never apply.

### 1.3 Reproduce the V2 wasm hash

The on-chain WASM hash `d9ad61c2…10142c` matches the local `cargo build --release` output
byte for byte, so the code above is the code the 17 V2 tests cover.

```bash
cd contracts/vault
cargo build --release --target wasm32-unknown-unknown
shasum -a 256 target/wasm32-unknown-unknown/release/trigger_vault.wasm
stellar contract fetch --id CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT \
  --network testnet --out-file onchain.wasm && shasum -a 256 onchain.wasm
```

---

## 2. V3 — stop-loss (deploy + tests + simulations, no live execution)

### 2.1 Deployment

| Step | Transaction |
| --- | --- |
| WASM upload — `4ced7ccf…4377d8` | [`6c6fecf9…828e6`](https://stellar.expert/explorer/testnet/tx/6c6fecf9cc2a783faf5c56469b1dd72b60af1c5d314de11b037212dd8fa828e6) |
| Deploy + constructor | [`da22a964…86f905`](https://stellar.expert/explorer/testnet/tx/da22a964c2c97399a40b1ab8b73200923e1b3d32c0e1411ec5c8a7671886f905) |

Fees actually charged: upload 3.4824592 XLM, deploy + constructor 56.3740648 XLM — 59.856524
XLM in total. The deploy leg is dominated by rent: extending the instance TTL also extends
the 24 981-byte wasm code entry the instance points at, and the constructor triggers that
bump. V2's create cost 0.0033409 XLM because V2 has no constructor and left the bump to its
first call. Full parameter record: [`V3_DEPLOY_MANIFEST_TR.md`](V3_DEPLOY_MANIFEST_TR.md).

### 2.2 Reproduce the V3 wasm hash

```bash
cd contracts/stop_vault
cargo build --release --target wasm32-unknown-unknown
shasum -a 256 target/wasm32-unknown-unknown/release/trigger_stop_vault.wasm
stellar contract fetch --id CD36555E46SJ5X6WD7H6RLOCWEOHAMQLOQY55CJ4G3KGD3TNQM243MBL \
  --network testnet --out-file onchain.wasm && shasum -a 256 onchain.wasm
```

Both print `4ced7ccf3aec9f4cd9f64c3c0766f23c76a765fb22410cae7727a1f4eb4377d8`. Note that
`stellar contract upload` and `deploy` optimize by default; this artifact was uploaded with
`--optimize=false` so the on-chain hash is the one the plain `cargo build` above reproduces.

### 2.3 Constructor, read back from the chain

`get_config` returns every field unchanged from deployment. None of them has a setter.

| Field | Value |
| --- | --- |
| `router` | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` |
| `collateral_token` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` (XLM SAC) |
| `payout_token` | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (USDC SAC) |
| `max_amount_in` | `100000000` — 10.0000000 XLM per order |
| `policy.source` | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| `policy.base` / `.asset` / `.quote` | `Other("USD")` / `Other("XLM")` / `Other("USDC")` |
| `policy.decimals` | `14` |
| `policy.max_age_secs` / `.max_skew_secs` / `.max_future_secs` | `900` / `60` / `0` |
| `policy.version` | `1` |

`current_price()` returns a live cross rate. That single read exercises `decimals()`,
`base()`, both `lastprice()` legs, the staleness and skew gates and the cross-rate
arithmetic against the real Reflector feed.

### 2.4 Guard cases simulated against the live contract

All run with `--send=no`. Nothing was written to the chain; `get_order_count` was `0` before
and after.

| # | Call | Expected | Result |
| --- | --- | --- | --- |
| 1 | `get_order(1)` with no orders | `OrderNotFound` (#1) | ✅ |
| 2 | `trigger_stop(1)` with no orders | `OrderNotFound` (#1) | ✅ |
| 3 | `create_stop_order` with stop **above** the feed (0.20) | `StopNotBelowMarket` (#12) | ✅ |
| 4 | `create_stop_order` with 20 XLM against a 10 XLM cap | `AmountTooLarge` (#25) | ✅ |
| 5 | `create_stop_order` with the reversed pair (USDC→XLM) | `TokenNotAllowed` (#5) | ✅ |
| 6 | `create_stop_order` with `fee_bps = 1500` | `InvalidFee` (#3) | ✅ |
| 7 | `create_stop_order` with a past deadline | `InvalidDeadline` (#6) | ✅ |
| 8 | `create_stop_order` with valid parameters | success | ✅ — emitted `("stop","created")` with `(1, owner, 30000000, 18950000000000)` |

Case 8 matters twice: it proves the accepting path reachable, and its event is exactly the
shape the console's `createdOrderIdFrom` parser reads an order id out of.

### 2.5 The one live stop order

A single stop order exists on V3, created by its owner through the deployed console. Read
back from the contract:

| Field | Value |
| --- | --- |
| `amount_in` | `90000000` — 9.0000000 XLM |
| `min_user_out` | `9000000` — 0.9000000 USDC (net, after the bounty) |
| `trigger` | `PublicStopBelow: 17000000000000` — 0.1700000 USDC/XLM |
| `fee_bps` | `100` |
| `status` | `0` — **Armed** |
| `triggered_at` / `observed_price` | `0` / `0` — never triggered |

The feed sat around 0.189 USDC/XLM when this was recorded, so the order needs roughly a 10%
fall before `trigger_stop` can succeed. **It has not triggered, and nothing has been sold.**
This order is evidence that the create path works end to end from the deployed app; it is
not evidence of a stop-loss execution.

### 2.6 Price divergence — a dated sample

Two readings taken within the same minute on 20 September 2026:

| Source | USDC/XLM |
| --- | --- |
| Reflector cross (XLM/USD ÷ USDC/USD) | 0.1898527 |
| Soroswap testnet pool, 10 XLM quote | 0.1053589 |
| Ratio | 1.80× |

This is a single dated observation of a testnet pool, not a claim about how that pool
behaves over time. It is recorded because it is the concrete reason a triggered stop can
still refuse to settle: the price that permits the sale and the price that fills it are read
from two different places.

---

## 3. Earlier deployments — and why the console still lists them

Order ids restart at 1 in every deployment, and collateral does not move when a new one goes
up. Retiring a vault by pointing a constant at a new address would quietly orphan whatever
the old one still holds, so `frontend/src/vaults.ts` keeps a **list**: earlier vaults stay
readable and cancellable, and `acceptingOrderTypes` says per-vault which instructions each
one still takes.

**V1 — [`CDVJV6SI…WK3BNTWD`](https://stellar.expert/explorer/testnet/contract/CDVJV6SITYH2A4CNTG4YG5CDYDRM5ABTDIBA3UVBLXFQNE6FWK3BNTWD)** · four resting orders · *gross* minimum

Fully working, and its settlement is real: `execute_order`
[`7b135e3d…578179`](https://stellar.expert/explorer/testnet/tx/7b135e3dfd76175b746bb015d3eb03e806dd23997979b26d3f8fce9ca0578179)
swapped 15 USDC for 141.5242761 XLM through the same Soroswap router, paying a 1.4152427 XLM
bounty and 140.1090334 XLM to the owner. It was replaced because its minimum guarded the
**swap output** rather than the payout: an order guarded at 38 paid 37.62 at 100 bps. The
four orders still resting there remain cancellable by their owners.

**V0 — [`CDERIBD7…GYQMPB`](https://stellar.expert/explorer/testnet/contract/CDERIBD7XORORRYYOZDM44EOJIHJWZGEBE7WTAMHJMYGWI33UKGYQMPB)** · *gross* minimum · never settled

The first deployment pushed collateral to the router before swapping. Soroswap does not take
custody — it pulls from the order's owner — so execution always reverted on an authorization
mismatch and no `execute_order` ever succeeded there. Creation and cancellation did work:

- `create_order` — [`1352efc1…68ec5a`](https://stellar.expert/explorer/testnet/tx/1352efc105fbdbc48b2ff2c739af941473f36b0382ab48ba27e9e9e06868ec5a)
- `cancel_order` — [`a16bf08b…a39909`](https://stellar.expert/explorer/testnet/tx/a16bf08ba88b093c15a4ce7a424bf427cf6dd597467729d60e419321baa39909)

Collateral left on that instance is still reclaimable through `cancel_order`.

---

## 4. Automated tests

| Suite | Count | What it covers |
| --- | --- | --- |
| `contracts/vault` | 17 | V2 settlement, the balance-delta rule, three router doubles, auth, TTL |
| `contracts/stop_vault` | 34 | V3 trigger/settle/cancel, oracle validation, the same three router doubles under a controlled oracle |

Run them:

```bash
cd contracts/vault && cargo test
```

```bash
cd contracts/stop_vault && cargo test
```

The stop vault's oracle doubles let the tests drive stale samples, skewed legs,
future-dated samples, wrong scales and a missing feed — conditions that cannot be produced
on demand against the live Reflector deployment.

---

## 5. What is not verified

- **No real price fall has driven `trigger_stop` → `execute_stop` on V3.** The one live stop
  order is Armed and has never triggered.
- **Independent keeper execution is untested.** Every completed settlement above was signed
  by the order's own owner. The keeper has only been run without a signing key, in read-only
  scan mode.
- **The stop form under an adversarial wallet** — rejected signatures, account switches
  mid-flight — has not been exercised against the live contract.
- **The TRY bank leg is simulated.** The anchor is a sandbox; the Stellar leg is a real
  testnet transaction, the bank transfer is not.
- **Nothing here is audited**, and none of it has run on mainnet.
