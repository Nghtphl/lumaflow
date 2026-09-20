# TriggerVault — Pro Hackathon 2026 readiness review

Reviewed **2026-09-19** against *Pro Hackathon 2026 Tracks & Handbook* (Rise In × Stellar).
Submission deadline: **Day 2, 12:00**.

---

## Verdict

The Soroban work is the strong part: the contract is clean, auth and TTL patterns are
deliberate, the balance-delta slippage check is better engineering than most hackathon
code, and there are 9 unit tests. What is missing is almost entirely **the part the rubric
weights highest** — a fiat rail — plus proof that the DEX integration works against a real
protocol rather than a test mock.

| Handbook requirement | Status |
| --- | --- |
| 1. Integration with an eligible protocol | ⚠️ **Interface only.** The router interface matches Soroswap's, but the only implementation it has ever been called against is `MockRouter` in `test.rs`. As written it would fail against the real router (see P0-2). |
| 2. Anchor / local payments (TRY ⇄ Stellar) | ❌ **Absent.** No SEP-1/6/10/24/31/38 anywhere in the repo. *"Anchor and local payment integrations carry the highest weight."* |
| 3. Core feature — integration is load-bearing | ⚠️ The swap is load-bearing in design; nothing proves it on testnet. |
| Deployed on testnet, real functionality | Vault redeployed as `CDVJV6SI…` on the current build, initialised with the real Soroswap router. The previous instance `CDERIBD7…` ran an older build whose settlement path pushed collateral to the router instead of authorising its pull, so `execute_order` always reverted there and never completed. Settlement is unproven on chain until one runs on the new instance. |
| Mermaid architecture diagram (Scale Track) | ❌ Missing |
| Stellar Skills cited by path | ❌ Missing (explicit submission requirement) |
| Public repo + README + live demo URL + documented contract IDs | ⚠️ Repo yes; README is 755 bytes; no deployment config, no live URL |

---

## P0 — blockers, in the order I would do them tonight

### P0-1 · Ship the anchor rail
See `docs/ANCHOR_INTEGRATION.md`. This is the single highest-scoring piece of work
available and nothing else competes with it for time. Minimum viable version: the **deposit**
direction (TRY → USDC → order collateral) end-to-end with real transaction hashes.

### P0-2 · `execute_order` cannot work against the real Soroswap router

`contracts/vault/src/lib.rs` does this:

```rust
token_in_client.transfer(&env.current_contract_address(), &router, &order.amount_in); // ← pre-transfer
router_client.swap_exact_tokens_for_tokens(&order.amount_in, …, &env.current_contract_address(), &deadline);
```

The real Soroswap router does this:

```rust
to.require_auth();
TokenClient::new(&e, &path.get(0).unwrap()).transfer(&to, &pair, &amounts.get(0).unwrap());
```

It **pulls** `amount_in` from `to` (your vault) and sends it to the *pair*, not the router.
So the current flow (a) strands `amount_in` at the router address and (b) then asks the
vault to pay a second time — from a balance it no longer has — via a deeper sub-invocation
that the vault has not authorized. Both halves fail. `MockRouter` hides this because it
pays out of its own pre-minted balance and ignores the tokens it was sent.

Two ways out, pick by remaining time:

* **Correct Soroswap call (better score, ~1–2 h).** Delete the pre-transfer; before the
  swap, authorize the router's sub-invocation from the vault with
  `env.authorize_as_current_contract(vec![&env, InvokerContractAuthEntry::Contract(
  SubContractInvocation { context: ContractContext { contract: token_in, fn_name:
  symbol_short!("transfer"), args: (vault, pair, amount_in).into_val(&env) },
  sub_invocations: vec![&env] })])`, where `pair` comes from the Soroswap factory
  (`get_pair` / `pair_for`). Then re-point the deployed vault at the real testnet router
  with `set_router` and land **one real `execute_order` transaction** — that hash is the
  proof the rubric is asking for.
* **Settlement pattern (safer, ~30 min).** Keep the vault DEX-agnostic: transfer `amount_in`
  to the executor, let the keeper route through **Soroswap's Routing API** (an eligible
  partner in its own right), and require the executor to deliver ≥ `min_amount_out` back
  within the same transaction. Your existing balance-delta check already enforces this
  atomically — the design is sound, it just needs the transfer target changed and a test.

Either way: **add an integration test against a router that pulls funds the way the real
one does**, so the mock stops flattering the code.

### P0-3 · Remove fabricated data from the UI
`frontend/src/App.tsx` invents order timestamps:

```ts
createdAt: new Date(fetchedAt - Math.max(0, count - (index + 1)) * 60_000).toISOString()
```

That is hardcoded fake data in a rubric that says *"real functionality — not mocked or
hardcoded"*. Fix by emitting `env.ledger().timestamp()` into the `Order` struct (one field,
one migration-free change since you can redeploy) or by reading the creation ledger time
from the event/tx. If neither fits the time budget, drop the column.

Same category: the empty-state copy claims *"Autonomous keeper engine is actively scanning
order book"* while no keeper is deployed. Either run the keeper somewhere public or change
the wording.

### P0-4 · Live demo URL
The handbook requires *"a functional, publicly accessible application that judges can
interact with"*. There is no deploy config in the repo. `npm run build` + Vercel/Netlify/
Cloudflare Pages, with the env vars from `frontend/.env.example`, is 10 minutes. Put the URL
in the README, in the submission form, and on the last slide.

### P0-5 · README rewrite (it is a judged artifact)
755 bytes will not carry criterion 6. It needs: the "why" narrative and target user
(Turkish retail, lira-denominated), the anchor flow, an architecture section with the
**Mermaid** diagram, **documented contract IDs** (vault, USDC SAC, router) with
stellar.expert links, env vars, setup/run/test instructions for all three packages, the live
demo URL, known limitations, and the **Stellar Skills used, cited by path**.

### P0-6 · Fix the repo's self-inflicted credibility bugs
* `keeper/.env.example` points at `CAAAAAAA…D2KM`, a placeholder — it should be the real
  deployed vault id. A judge who clones and runs the keeper hits this in the first minute.
* `SECURITY.md` contains **7 raw control characters** (BEL/FF/CR) from an escaping bug:
  "mount > 0" (was `amount`), "oken_in" (was `token_in`), "ee <= 10%" (was `fee`),
  "\\\ust" (was ```` ```rust ````), "pm audit" (was `npm audit`). Rewrite the file.
* `SECURITY.md` §3.1 documents an implementation that no longer exists
  (`env.invoke_contract(&router, &symbol_short!("swap"), …)` returning `received_out`),
  while the code uses a balance delta. Docs contradicting code reads worse than no docs —
  and the balance-delta approach is the *better* story, so tell it.
* Two diverging copies of `SECURITY.md` (root + `frontend/`). Keep one.
* `frontend/index.html` still has `<title>frontend</title>`; `frontend/README.md` is still
  the stock Vite template.
* No `target/` in the working tree — **run `cargo test` and `cargo build --release
  --target wasm32-unknown-unknown` before submitting**; nothing in this checkout proves the
  contract still compiles.

---

## P1 — worth doing if P0 lands early

* **Manual "Execute now" button** for the order owner. The keeper is the product, but a jury
  that can trigger execution in the browser sees the full lifecycle in 30 seconds instead of
  waiting for a bot they can't see. Cheap, and it also gives you a live fallback if the
  keeper dies on stage.
* **Deploy the keeper** (Fly.io / Railway / a laptop tmux with logs on screen) and show its
  log during the demo. "How many teams shipped a core feature integration" is a tracked
  metric; a running keeper is the visible form of that.
* **Order timestamps + tx hashes on chain** — emit them in events and index them, so history
  is real.
* **Stop-loss claim.** README and pitch say "Limit and Stop-Loss"; the contract implements a
  limit primitive only, and `docs/SPECIFICATION.md` admits it ("not an oracle-based
  stop-loss"). Either drop the claim or wire **Reflector** (an eligible oracle in the
  handbook's resources) for a genuine trigger price — the latter is a strong Scale Track
  story if time allows.
* **Traction.** The handbook counts *"how many onboarded real users"* during the event. With
  a live demo URL and the TRY deposit flow, walking five people at the venue through a
  deposit is realistic — and it is the only criterion you cannot backfill afterwards.

## P2 — polish

* Mobile layout for the terminal (the grid is desktop-first).
* Accessibility pass: the UI is 10px mono on dark; contrast and focus rings matter for the UX score.
* `get_order_count`-then-N-reads is O(n) round trips; batch or paginate before the order
  list grows.
* Frontend divides every amount by `STROOPS_PER_XLM` regardless of the asset — fine while
  everything is 7-decimal, but name the constant accordingly (`STROOPS`) to avoid a trap.
* `.cursorrules` exists but there is no `CLAUDE.md`/agent-facing doc describing the repo;
  cheap to add and it reinforces the "Skills and AI tooling" story the handbook rewards.

---

## Submission checklist

- [ ] Track selected on the portal (you are only judged on tracks chosen at submission) — *organiser portal action*
- [x] Public GitHub repo + well-structured README
- [x] Contract IDs documented (vault / USDC SAC / router) with explorer links
- [x] Live demo URL, reachable from a stranger's laptop
- [x] Anchor flow demonstrable end-to-end with real tx hashes — *SEP-6 deposit, create_order and cancel_order verified in the README*
- [ ] One real `execute_order` transaction on testnet — **blocked**: the vault's router slot holds an account, not the Soroswap router. Run `set_router` as admin, then execute once. See the README's known-issue note.
- [x] Mermaid architecture diagram in the README/docs
- [x] Stellar Skills cited **by path**
- [x] `cargo test` green; `cargo build --release --target wasm32-unknown-unknown` clean
- [ ] Pitch deck built on the official template — *official template not in the repo*
- [x] Scale Track only: post-hackathon roadmap toward SCF/InstAward
