# Security policy — LumaFlow

**Stellar Testnet only. Not audited. No mainnet value is at risk.**

LumaFlow is a hackathon project. Nothing here has been reviewed by a third party, and the
internal review that has been done ([`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md))
is exactly that — internal. It found and fixed five issues and left nine risks open. Treat
this policy as a description of what the system tries to guarantee, not a claim that it
succeeds.

---

## Scope

**In scope** — code and configuration in this repository:

| Component | Path |
| --- | --- |
| V2 limit vault | `contracts/vault/` |
| V3 stop vault | `contracts/stop_vault/` |
| Console (dApp) | `frontend/` |
| Anchor client (SEP-1/6/10/38) | `frontend/src/anchor/` |
| Keeper | `keeper/` |

**Out of scope** — dependencies this project uses but does not control: Stellar RPC and
Horizon, the Soroswap router and pools, the Reflector oracle, the TRY anchor, and Vercel.
Please report issues in those to their own maintainers. Do not attack, fuzz or load-test
them on this project's behalf.

**Deployed contracts** — these addresses are what the console talks to:

| | Address | On-chain wasm |
| --- | --- | --- |
| V2 limit | `CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT` | `d9ad61c2…10142c` |
| V3 stop | `CD36555E46SJ5X6WD7H6RLOCWEOHAMQLOQY55CJ4G3KGD3TNQM243MBL` | `4ced7ccf…4377d8` |

Both are reproducible from this source — the commands are in
[`docs/VERIFICATION.md`](docs/VERIFICATION.md).

---

## What the contracts enforce

These are on-chain invariants, covered by 17 (V2) and 34 (V3) tests.

- **Balance-delta settlement.** The vault does not trust the router's return value. It reads
  its own `token_out` balance before and after the swap and treats the difference as the
  realised output. A router that reports a good fill while delivering less, and one that pays
  out without taking the input, both fail. Each has a regression test.
- **The floor is net.** The keeper bounty is taken from the observed delta first; what
  remains is checked against `min_user_out`. The guarantee is about the amount that reaches
  the owner's wallet, not about the swap output.
- **Non-custodial escrow.** Collateral sits in the vault under the order's owner until the
  order settles or is cancelled. Only the owner can call `cancel_order`, and it refunds the
  whole amount.
- **Bounded bounty.** Capped at 1,000 bps (10%) and computed from the realised output, never
  taken from collateral up front.
- **Scoped authorization.** The router's pull of the input is authorized through a single
  sub-invocation naming one token, one exact amount and a recipient the router computes — not
  a blanket approval.
- **Atomic failure.** If the owner's share falls short, or a transfer fails, the whole
  transaction reverts.
- **TTL managed.** Persistent entries target a ~120-day TTL, renewed under ~30 days.
  Simulating a getter does not renew anything; only a state-changing transaction does.

### V3 adds

- **No admin, no setters, no upgrade entry point.** The router, oracle, oracle policy, token
  pair and per-order size cap are fixed by the constructor and cannot be changed afterwards.
- **The oracle is validated, not trusted.** Scale, base, staleness, cross-leg skew and
  future-dating are each a distinct error, so an unreadable feed can never be mistaken for a
  feed saying the trigger was not met. A zero or negative price is refused before any
  arithmetic.
- **The exit does not depend on the feed.** `cancel_order` reads no price and calls no
  router, so an owner's way out does not require the oracle to be up.
- **A stop must sit strictly below the feed.** `create_stop_order` refuses a `stop_price` at
  or above the current price rather than escrowing collateral against an order that would
  trigger on its first reading.
- **Triggering is separated from selling.** `trigger_stop` records the fall and moves no
  funds; `execute_stop` attempts the sale in its own transaction. A failed swap therefore
  cannot erase a fall that genuinely happened.

---

## What it does not protect against

Stated plainly, because a security policy that only lists guarantees is misleading.

- **A stop-loss is not a promise of a sale.** A price gap, an oracle outage or a keeper
  outage can leave a triggered order unfilled. On a failed settlement the collateral **stays
  escrowed in the contract** — it does not return to the wallet by itself. Reclaiming it
  takes a cancellation.
- **Cancellation still needs a transaction.** It is open while an order is Armed, Triggered
  or past its deadline, but it depends on the network being reachable and the order's state
  still being live on ledger. It is not an unconditional guarantee.
- **The oracle is a third party with a live admin and an `update_contract` entry.** V3's
  address is fixed and has no setters — that means this project will not move the oracle, not
  that the oracle cannot move.
- **`max_age_secs = 900` is a testnet choice**, derived from a 13-minute, three-publication
  sample against a 300-second feed cadence. It is not a validated staleness bound.
- **The TRY bank leg is simulated.** The anchor is a sandbox; the Stellar side is real.
- **Independent keeper execution is untested.** Every settlement on record was signed by the
  order's own owner.
- **No real price fall has driven a V3 stop through to settlement.**
- **Token issuers retain their own powers.** Trustline authorization and asset controls sit
  with the issuer, not with this contract.
- **A compromised frontend or RPC can propose a wrong transaction.** The contract enforces
  its invariants regardless, and every action shows a summary before the wallet opens — but
  the wallet prompt is the last line of defence. Read it.

---

## Reporting a vulnerability

**Please do not open a public issue containing exploit details.**

1. **Preferred** — GitHub's private vulnerability reporting on
   [this repository](https://github.com/Nghtphl/lumaflow). If the "Report a vulnerability"
   button is not visible, the feature is not enabled yet; use step 2.
2. **Otherwise** — open a public issue titled `Security contact request` containing **no
   details**, and a private channel will be arranged.

Useful in a report: the affected component, the preconditions, a reproduction, and what an
attacker actually gains. If you are unsure whether something counts, report it.

**What to expect.** This is a solo project with no funding and no bug bounty. There is no
guaranteed response time and no reward. Fixes land in public commits with the reasoning
written out.

**Testnet only.** Please do not test against mainnet — there is nothing of this project
deployed there. Do not attempt to attack the third-party services listed under *Out of
scope*.

---

## Related

| Document | Contents |
| --- | --- |
| [`docs/SECURITY_REVIEW.md`](docs/SECURITY_REVIEW.md) | Internal review: trust boundaries, findings, fixes, and the risks left open |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | On-chain evidence, decoded transactions, wasm reproduction |
| [`docs/FINAL_QA_REPORT.md`](docs/FINAL_QA_REPORT.md) | Screen-by-screen QA pass |
| [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) | Entrypoints, slippage and TTL semantics |
| [`docs/STOP_LOSS_DESIGN_TR.md`](docs/STOP_LOSS_DESIGN_TR.md) | Stop-loss threat model (Turkish) |
