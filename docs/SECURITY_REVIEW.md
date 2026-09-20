# Internal security review — LumaFlow

**This is an internal review, not an audit.** It was carried out by the project's own
tooling against its own code. It does not certify the system, and it cannot: no review
finds every flaw, and nothing here should be read as "the vulnerabilities are closed".
What it does is record what was looked at, what was found, what was fixed, and what
remains unknown.

| | |
| --- | --- |
| Reviewed at | `f4d7933` on branch `qa-hardening`, off `e2afb18` on `main` |
| Date | 20 September 2026 |
| Scope | Code and configuration under this repository's control |
| Out of scope | Stellar RPC, Horizon, Soroswap, Reflector, the anchor provider, Vercel. No attack, fuzzing or load testing was directed at any third party; their failure modes were reproduced locally instead. |
| Chain actions taken | **None.** No transactions, no deploys, no fund movement, no changes to existing orders. |

Related: [`FINAL_QA_REPORT.md`](FINAL_QA_REPORT.md) · [`VERIFICATION.md`](VERIFICATION.md)

---

## 1. Trust boundaries

| Boundary | What crosses it | Who controls the other side |
| --- | --- | --- |
| Browser → Freighter | unsigned XDR, network passphrase, expected address | the user |
| Browser → Soroban RPC / Horizon | reads, simulations, signed submissions | public infrastructure |
| Browser → anchor | SEP-1 TOML, SEP-10 challenge, SEP-6 rails, SEP-38 quotes | **the anchor operator** |
| Contract → Soroswap router | one scoped sub-invocation | a third-party contract |
| Contract → Reflector oracle | price samples, scale, base | **a third party with a live admin and an upgrade entry** |
| Keeper → chain | optional signing key | the operator |
| Repo → Vercel | build-time env, inlined into the bundle | the project owner |

The two boundaries worth the most attention are the anchor and the oracle, because both
return data the receiving side then acts on, and both are controlled by someone else.

---

## 2. Findings

Severity is about impact on a real user of this deployment, not on a hypothetical one.

### SEC-1 · Medium · SEP-10 challenge was not bound to the connected wallet

**File** `frontend/src/anchor/sep10.ts` — `assertValidChallenge`
**Precondition** A malicious or compromised anchor, or a hijacked response.
**Reproduction** Build a challenge whose first `manageData` operation is sourced by an
account other than the connected wallet; the validator accepted it and the client passed it
to Freighter for signing.
**Real impact** Limited but real. The signature would not have authenticated the other
account — a conforming SEP-10 server checks that the signer matches the operation source —
so this is not account takeover. What it is: the wallet being asked to sign a statement
about an account that is not the user's, on our prompting. Asking is the part we control.
**Fix** The first operation's source is compared to the connected account and a mismatch
throws before anything reaches the wallet.
**Regression test** `sep10.test.ts` — "refuses a challenge that names a different client
account". Verified load-bearing: disabling the assertion fails exactly that test.

### SEC-2 · Low–Medium · `web_auth_domain` was not verified

**File** `frontend/src/anchor/sep10.ts`
**Precondition** Two services trusting the same SEP-10 signing key, one of them hostile.
**Reproduction** A challenge carrying `web_auth_domain` naming a different host was accepted.
**Real impact** A challenge issued for one service could be replayed against another. This
deployment talks to a single anchor, so it is a hardening gap rather than an exploitable
path here.
**Fix** When the operation is present its value must match the host of the configured
`WEB_AUTH_ENDPOINT`. The operation is optional in SEP-10, so absence is tolerated and only a
mismatch is refused.
**Regression test** Two cases in `sep10.test.ts` — a mismatched value throws, an absent
operation does not.
**Confirmed non-breaking** The live sandbox anchor sends the operation and its value already
matches, checked before the change shipped.

### SEC-3 · Low · TOML reader's prototype safety was accidental

**File** `frontend/src/anchor/toml.ts` — `parseToml`
**Precondition** A hostile anchor serving `__proto__ = "…"` in its stellar.toml.
**Reproduction** The key pattern `[A-Za-z0-9_]+` matches `__proto__`. It was safe only
because keys are upper-cased before assignment and `__PROTO__` is an ordinary property.
**Real impact** None today. The risk was that the upper-casing looks like formatting and
could be removed by someone who did not know it was load-bearing.
**Fix** Parsed tables are null-prototype objects and `__PROTO__`, `CONSTRUCTOR` and
`PROTOTYPE` are refused outright.
**Related advisory** `npm audit` reports prototype pollution in `toml`
(GHSA-v5mp-jgw5-2x6j), reachable through `@stellar/stellar-sdk`. **Assessed as not reachable
here**: this client reads stellar.toml with its own reader, never imports the SDK's
`StellarToml` resolver, and the shipped bundle contains none of that module's symbols
(`StellarTomlResolver`, `TomlError`, `toml.parse` — zero occurrences). The keeper does not
parse TOML at all. The advisory's fix is a major SDK upgrade (12.3.0 → 17.x); that was not
taken blind. **Recorded as a remaining risk**, see §5.

### SEC-4 · Medium · Stale balance could be written under a new wallet

**File** `frontend/src/App.tsx`
**Precondition** Switching accounts in Freighter while a balance read is in flight.
**Reproduction** Account A's Horizon or SAC read resolves after the wallet has moved to B;
`setWalletBalance` / `setUsdcBalance` wrote it unconditionally.
**Real impact** The Max button sizes an order from that number and the insufficient-funds
check refuses one from it, so a user could be shown — and act on — another account's balance
at the exact moment they had just switched to the account they meant to trade with. The
contract would still refuse an over-sized transfer, so this is a correctness and trust
failure rather than a loss of funds.
**Fix** Each read claims the wallet it was started for; a read whose claim has moved on
returns its value without writing.
**Regression test** None automated — this is React state timing and the project has no DOM
test harness. Verified by reading the code path and by browser check. **Recorded as
untested-by-automation in §5.**

### SEC-5 · Medium (accuracy, not exploitability) · Product copy claimed more than was shown

**Files** `README.md`, `frontend/src/components/layout/Masthead.tsx`,
`frontend/src/pages/LandingPage.tsx`
**What was wrong** Four statements a judge or user could rely on:

1. "A stop cannot be opened at or below the market" — backwards. The contract refuses
   `price_now <= stop_price`, so a stop must sit strictly *below* the feed.
2. "Only the newest accepts new orders" — untrue since V3 shipped; V2 takes limit orders and
   V3 takes stops.
3. "Collateral never leaves the contract" — conflated escrow with outcome. On a failed
   settlement the collateral stays escrowed; it does not return to the wallet by itself.
4. "Lets an autonomous keeper close the position" — no independent keeper execution has been
   demonstrated. Every settlement on record was signed by the order's own owner.

**Real impact** This is the security-relevant kind of inaccuracy: a user deciding whether to
escrow funds, on the strength of a guarantee that was not the one the contract makes.
**Fix** All four corrected in place, plus the sandbox bank leg disclosed on the first screen
and the price-divergence figure dated and named as a single sample.

### Not findings — checked and clear

| Checked | Result |
| --- | --- |
| DOM XSS — `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` | none present |
| External links | all seven carry `rel="noreferrer"`, which implies `noopener` |
| Network guard before signing | `assertFreighterTestnet` runs before every transaction is built |
| Success shown on submission only | no — success requires `result.status === "SUCCESS"` after ledger confirmation |
| Confirmation timeout behaviour | 90 s, then reports "still in flight"; does **not** auto-resubmit |
| Double submission | `operationLock` guards every entry point; 7 acquisitions, 7 releases, each in a `finally` |
| Order id from the wrong transaction | the parser matches contract id **and** topic within that transaction's own events |
| Unknown enum / status defaults | refused rather than defaulted — now covered by tests |
| JWT storage | memory + `sessionStorage`, never `localStorage`; keyed per (home domain, account); `exp` honoured |
| SEP-1 discovery scheme | forced to `https://`, any supplied scheme stripped |
| SEP-6 polling | stops on terminal status, 5-minute ceiling, cancel on unmount, no write after cancel |
| Keeper read-only mode | every send path gated on a keypair, twice; no path reaches `sendTransaction` without one |
| Secrets in source / history / build | none found. `.env*` gitignored; no sourcemaps emitted; no `S…` seeds, JWTs or `VERCEL_OIDC_TOKEN` in the bundle |
| Contract: double trigger / double execute / cancel-execute race | each entry point asserts its required status; terminal states refuse |
| Contract: bounty and floor ordering | bounty from the observed delta, floor checked on the remainder |
| Contract: scoped authorization | one sub-invocation, fixed token, exact amount, computed recipient |
| Contract: `gross_floor_for` divisor | `fee_bps` capped at 1000, so the divisor is never below 9000 |
| Contract: oracle division | zero and negative prices rejected before the divide |

---

## 3. Effect on deployed code

**No contract source was changed, so nothing in this review requires a redeploy.** The V2
and V3 contracts on chain are the same bytecode they were before it started:

| | Address | On-chain wasm |
| --- | --- | --- |
| V2 | `CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT` | `d9ad61c2…10142c` |
| V3 | `CD36555E46SJ5X6WD7H6RLOCWEOHAMQLOQY55CJ4G3KGD3TNQM243MBL` | `4ced7ccf…4377d8` |

Every fix above is frontend or documentation. No finding was severe enough to justify
closing order creation in the interface, and none was found in the contracts themselves.

---

## 4. Tests added

| Suite | Tests | Covers |
| --- | --- | --- |
| `frontend/src/stopVault.test.ts` | 15 | price scaling and its refusals, status and trigger enums, config parsing, deadline boundary |
| `frontend/src/anchor/sep10.test.ts` | 8 | every SEP-10 challenge assertion, each malformed challenge built locally |

Both suites pass. The SEP-10 client-account assertion was mutation-checked: disabling it
fails exactly one test and no others.

---

## 5. Remaining risks

These are open. None of them is closed by anything above.

1. **The oracle is a third party with a live admin and an `update_contract` entry.** V3's
   address is fixed and has no setters, which means this project will not move the oracle —
   not that the oracle cannot move. A hostile or buggy oracle upgrade can change what
   triggers a stop.
2. **`max_age_secs = 900` is a testnet choice.** It came from a 13-minute, three-publication
   sample against a 300-second cadence. It is not a validated staleness bound.
3. **The `toml` advisory remains open in the dependency tree.** Assessed as not reachable in
   the shipped bundle (§SEC-3). Closing it properly means a major `@stellar/stellar-sdk`
   upgrade, which is its own migration and was not attempted here.
4. **SEC-4 has no automated regression test.** It is React state timing and the project has
   no DOM test harness; adding one was out of proportion to a single fix.
5. **Signed flows are unverified end to end.** Everything requiring a Freighter signature —
   rejected signatures, account switches mid-flight, the stop form's submit path — was
   reviewed by reading and by simulation, not by signing. No attempt was made to bypass the
   wallet.
6. **Independent keeper execution is untested.** Every settlement on record was signed by the
   order's owner. Automated tests and simulations are not evidence of this.
7. **No real price fall has driven a V3 stop through to settlement.**
8. **Third-party dependencies were not tested.** RPC, Horizon, Soroswap, Reflector, the
   anchor and Vercel were exercised only by ordinary reads. Their failure modes were
   reproduced locally.
9. **No audit.** Nothing here substitutes for one.
