# Final review — LumaFlow

The closing pass over the QA and security work: re-checking that the fixes did what they
claimed, that nothing they touched regressed, and that what is live is what is in the
repository.

| | |
| --- | --- |
| Branch | `main` |
| Last code commit | `f681bef` |
| Rollback point | `e2afb18` — the state before this round |
| Live | <https://lumaflovv.vercel.app> |
| Contracts | unchanged — **no redeploy required or performed** |
| Chain actions | none: no orders created, executed or cancelled; no deploys; no fund movement |
| Keeper | never started with a signing key |

Companion reports: [`FINAL_QA_REPORT.md`](FINAL_QA_REPORT.md) ·
[`SECURITY_REVIEW.md`](SECURITY_REVIEW.md) · [`VERIFICATION.md`](VERIFICATION.md)

---

## 1. What this round found

One fix from the earlier pass **did not work**, and the earlier report said it did.

**The stepper overflow was reported fixed and was not.** "Ledger Confirmation" clips its
72px column at 375px. The first attempt — balanced wrapping plus hyphenation — left the
label free to size itself to its longest word, so it sat at 81px inside a 72px column and
still spilled. Adding `break-words` removed the overflow but produced "Submissio / n", a
hard break mid-word, which is worse than the original bug.

This was caught by re-measuring **production after the deploy**, not by trusting the earlier
result. The working fix constrains the label to its column and drops it to 10px below `sm`.
All four labels now wrap at their space in two lines, nothing is cut, and desktop is
untouched at 11px. Zero overflowing elements at 375px, measured.

`FINAL_QA_REPORT.md` was corrected rather than quietly updated: it now records that the
first fix failed and how it was caught.

Nothing else from the earlier round regressed. Every other fix was re-verified against the
code as it stands now, not against the result it produced when it was written.

---

## 2. Verification of the earlier fixes

| Fix | Re-checked how | Result |
| --- | --- | --- |
| Stale balance write under a switched wallet | code path re-read; the claim-before-read guard is still in place on both readers and in `refreshBalances` | holds |
| Landing copy — two instruments, no unproven automation, escrow wording, sandbox disclosure | live page text at <https://lumaflovv.vercel.app> | all four present, old claim absent |
| README corrections — stop-price rule, per-vault acceptance, escrow language | re-read against `create_stop_order` and `vaults.ts` | match the code |
| SEP-10 client-account and `web_auth_domain` assertions | 8 tests, plus a mutation check disabling the client-account assertion | test fails when the assertion is removed |
| TOML prototype hardening | live anchor discovery, `/info` limits and SEP-38 quote in the browser | all resolve |
| Stepper overflow | measured at 375px and 1024px | **failed, refixed, re-measured** |

---

## 3. Checks

| Suite | Result |
| --- | --- |
| `contracts/vault` | 17 passed |
| `contracts/stop_vault` | 34 passed |
| `frontend` `tsc -b` | clean |
| `frontend` `vitest` | 23 passed |
| `frontend` `vite build` | clean |
| `frontend` `oxlint` | 6 warnings — all pre-existing in the older anchor files, count unchanged since before this work |
| `keeper` `tsc` | clean |

**Browser, on production:**

| Check | Result |
| --- | --- |
| `/` and `/console` direct load | HTTP 200 both |
| Wordmark `LUMAFLOW`; prose `LumaFlow`; no `TriggerVault` anywhere | ✅ |
| Headline names both instruments | "Limit orders and stop-loss that rest on Stellar." |
| Sandbox bank leg disclosed on the first screen | ✅ |
| Order queue reads all four deployments | ✅ V0×6, V1×4, V2×1, V3×1 |
| Vault chip | `CAVF2IT2…WP2INT` — the V2 limit vault |
| Stop form opens, shows the contract's cap and the live feed | ✅ "accepts at most 10.", feed read live |
| Active / Settled filters, Refresh | ✅ |
| Mobile 375px — no overflow anywhere | ✅ |
| Console errors across the pass | none |
| Bundle contains both contract addresses, no test code, no secrets, no sourcemaps | ✅ |

**Deployment:** commit status `success` for the merge, production deployment recorded
against the right ref, and the served bundle verified to contain the new landing copy and
both contract addresses. Push was not treated as deploy — each was checked separately.

---

## 4. Open

Unchanged by this round, and none of it closed by anything above.

1. **No real price fall has driven a V3 stop through to settlement.** The one live stop order
   is Armed at 0.1700 while the feed sits near 0.189.
2. **Independent keeper execution is untested.** Every settlement on record was signed by the
   order's own owner.
3. **Signed flows are unverified end to end** — order creation, trigger, execute, cancel,
   SEP-10 sign-in, SEP-6 deposit and withdraw. Reviewed by reading and simulation; no attempt
   was made to bypass the wallet.
4. **Wallet connect with no extension installed** hangs on "Connecting". `requestAccess()`
   never settles when Freighter is absent; the application's own error path is correct. Left
   alone: it sits in the wallet flow, and it affects only visitors without the extension this
   dApp requires.
5. **The `toml` advisory remains open in the dependency tree**, assessed as not reachable in
   the shipped bundle. Closing it means a major `@stellar/stellar-sdk` upgrade.
6. **The oracle is a third party with a live admin and an upgrade entry**, and
   `max_age_secs = 900` is a testnet choice from a 13-minute sample.
7. **Not audited.** The security review in this repository is internal and does not certify
   anything.

---

## 5. State

Nothing in this round changed contract source, so the bytecode on chain is the same as
before it started:

| | Address | Wasm |
| --- | --- | --- |
| V2 | `CAVF2IT2KTOES576A2WNIIQVIBNHWVGMSIRE55XFJGB6WD3R4HWP2INT` | `d9ad61c2…10142c` |
| V3 | `CD36555E46SJ5X6WD7H6RLOCWEOHAMQLOQY55CJ4G3KGD3TNQM243MBL` | `4ced7ccf…4377d8` |

All existing orders across V0, V1, V2 and V3 are untouched and remain readable and
cancellable by their owners.
