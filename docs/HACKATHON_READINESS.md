# LumaFlow — Pro Hackathon 2026 submission status

Re-verified **2026-09-20** against *Pro Hackathon 2026 Tracks & Handbook* (Rise In × Stellar).
Submission deadline: **Day 2, 12:00**.

Every ✅ below was checked by querying Soroban RPC and Horizon directly on the date above —
not by reading this repository's own prose. Where a claim rests on something outside the
chain (the organiser's portal, a slide deck), it is marked ❓ rather than ✅.

---

## Verdict

The handbook's two heaviest criteria — an **eligible protocol integration that is
load-bearing**, and a **local payment / anchor rail** — are both satisfied and both have
transaction hashes behind them. What remains is administrative: portal fields, track
selection and the deck.

| Handbook requirement | Status |
| --- | --- |
| 1. Integration with an eligible protocol | ✅ **Proven on chain.** `execute_order` [`3b2e80ce…`](https://stellar.expert/explorer/testnet/tx/3b2e80cef75ab2381ffef82c7421f1e43bd132fbc62740746c7b5a4c612080ef) emits a `SoroswapRouter` `swap` from the published testnet router `CCJUD55A…` and a `SoroswapPair` `swap`/`sync` from the real pool `CCBX3NZT…`. 10 XLM in, 1.0535743 USDC out, 0.0105357 USDC bounty, 1.0430386 USDC to the owner. |
| 2. Anchor / local payments (TRY ⇄ Stellar) | ✅ **Implemented and exercised.** SEP-1/6/10/12/38 client in `frontend/src/anchor/`; deposit settled on chain in [`65434cdf…`](https://stellar.expert/explorer/testnet/tx/65434cdf31f19aa23d6408da4c3b6bf32587f3a169fadfa4088e44bbdb411d66). Sandbox anchor — see *Known limitations*. |
| 3. Core feature — integration is load-bearing | ✅ Settlement **is** the product. There is no code path that fills an order without going through the router, and the fill is validated by the vault's own balance delta. |
| Deployed on testnet, real functionality | ✅ Vault `CAVF2IT2…R4HWP2INT`, WASM `d9ad61c2…10142c` — verified byte-identical to a local `cargo build --release`. Router slot verified to hold the Soroswap router, not an account. Order #1 created and executed. Two earlier instances stay listed in the console so their resting collateral remains cancellable. |
| Mermaid architecture diagram | ✅ In `README.md`, nine-step flow from TRY deposit to TRY payout. |
| Stellar Skills cited by path | ✅ In `README.md`, five skill files with source repos. |
| Public repo + README + live demo URL + documented contract IDs | ✅ README documents vault, USDC SAC, USDC issuer, XLM SAC and router with explorer links. Live demo at <https://lumaflovv.vercel.app>. |
| `cargo test` green; release build clean | ✅ 17 tests passing as of 2026-09-20. |
| Pitch deck on the official template | ❓ **Not verifiable from this repository.** |
| Portal submission, track selection, team details | ❓ **Not verifiable from this repository.** |

---

## The one thing this repository cannot tell you

Four items are organiser-side and no amount of code changes them. They are the only
remaining way to lose points on something already built:

1. **Portal submission completed before the deadline.** The handbook states that
   incomplete or unsubmitted entries are not evaluated.
2. **Track selected.** Judging happens only against tracks chosen at submission time.
   Genesis caps the team at four and frames the product as built during the event — if any
   code predates it, separate the starting state from the event's work honestly. Scale has
   invitation/eligibility conditions; a project *fitting* Scale is not the same as being
   admitted to it.
3. **Team name, full names and contact details** filled in.
4. **Pitch deck built on the official template**, main structure preserved.

---

## V3 stop vault — status

Deployed to testnet and its automated tests pass; no end-to-end execution has
been driven by a real price fall.

`CD36555E46SJ5X6WD7H6RLOCWEOHAMQLOQY55CJ4G3KGD3TNQM243MBL`, wasm
`4ced7ccf…4377d8`, verified byte-identical against the local build. The
constructor's stored policy was read back from the chain and matches. Seventeen
V2 and thirty-four V3 contract tests pass against controlled oracle doubles, and
eight guard cases were simulated against the live contract without writing to
it. No stop order exists: `get_order_count` is 0. The keeper has only ever been
run without a signing key. Production is untouched — the deployed console still
offers limit orders only. Details in `V3_DEPLOY_MANIFEST_TR.md`.

## Known limitations — state these before a judge finds them

Volunteering these costs nothing and buys credibility. Each is real.

- **The executor and the owner are the same account in the proof transaction.** The bounty
  is genuinely computed by the contract from the observed delta and paid as its own
  transfer (`14152427` stroops, 100 bps), but the order was self-executed from the dApp.
  A separately funded keeper would make the split visually obvious.
- **The anchor is a sandbox.** The bank leg is simulated; the Stellar leg is a real testnet
  transaction. The client is written against the published SEPs, so the *protocol* surface
  is portable — but moving to a production anchor is **not** a one-line change. It depends
  on that provider's KYC requirements (SEP-12 fields), its supported rails and assets, and
  commercial onboarding. The honest claim is that no anchor-specific logic is hardcoded
  past the home domain, not that a swap is free.
- **Testnet only, unaudited.** No mainnet value is at risk. The roadmap schedules an audit
  scoped to the settlement path, authorization tree and TTL lifecycle.
- **Order history timestamps** are derived at read time, not emitted by the contract.
- **`get_order_count`-then-N-reads** is O(n) RPC round trips; fine at this order count,
  not a design to grow into.

---

## Resolved — the floor is now a net guarantee

The earlier deployment checked its minimum against the **gross** fill and deducted the
keeper bounty afterwards, so an order guarded at 38 paid out 37.62 at 100 bps: the
guarantee named a figure the owner never received.

The current contract stores `min_user_out` and checks it against the amount actually
transferred to the owner, raising the router's own minimum to the gross that leaves the
floor standing once the bounty is taken (rounding up, so truncation cannot land a stroop
short). `create_order` refuses an order whose floor could never be met before it takes
any collateral. Six regression tests cover it, including the exact boundary, the tightest
passing fill, a fill that clears gross but not net, and the maximum fee — 17 pass in all.

This shipped: vault `CAVF2IT2…R4HWP2INT`, proven by
[`3b2e80ce…`](https://stellar.expert/explorer/testnet/tx/3b2e80cef75ab2381ffef82c7421f1e43bd132fbc62740746c7b5a4c612080ef),
where the owner's 1.0430386 USDC is checked against a 1.0008955 USDC floor.

`frontend/src/vaults.ts` records the minimum's semantics per vault, so the console can say
truthfully which guarantee an order was written under rather than reinterpreting old
orders under new rules.

---

## Pre-submission sequence

1. Confirm sandbox-anchor acceptability and **track eligibility** with the organisers.
2. Finish the deck on the official template; fill every portal field.
3. **Hygiene, not a blocker:** the Vercel project's `VITE_VAULT_CONTRACT_ID` still names
   the retired V1 vault. The console ignores an environment value that names a retired
   vault and falls back to the registry, so the live site is correct as it stands — but
   set it to `CAVF2IT2…R4HWP2INT` so the hosted config stops disagreeing with the repo.
4. Open <https://lumaflovv.vercel.app> in a clean browser profile and walk the
   judge's path end to end.
5. Freeze the submission commit.
