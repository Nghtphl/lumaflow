# QA report — LumaFlow

Systematic pass over the deployed application's screens, states and flows. Paired with
[`SECURITY_REVIEW.md`](SECURITY_REVIEW.md); the two share one branch and one set of commits.

| | |
| --- | --- |
| Baseline | `e2afb181ed659453534e0dd9745901bceb83dd1f` (`main`) — rollback point |
| Work branch | `qa-hardening` |
| Date | 20 September 2026 |
| Chain actions | **none** — no orders created, executed or cancelled; no deploys; no fund movement |
| Keeper | never started with a signing key |

---

## 1. Inventory and results

**Legend** — ✅ tested and passing · 🔧 failed and fixed · ⚠️ could not be verified

### Landing (`/`)

| Item | Result |
| --- | --- |
| Page loads, no console errors | ✅ |
| Wordmark renders `LUMAFLOW`; prose renders `LumaFlow` | ✅ |
| Headline and copy describe the shipped product | 🔧 described limit orders only — [SEC-5](SECURITY_REVIEW.md#sec-5--medium-accuracy-not-exploitability--product-copy-claimed-more-than-was-shown) |
| Automation claim matches what has been demonstrated | 🔧 claimed autonomous keeper execution |
| Escrow and cancellation described accurately | 🔧 "cancellable at will", "yours the whole time" |
| Sandbox bank leg disclosed on the first screen | 🔧 was not |
| "Open the console" links (×2) | ✅ |
| "Inspect the contract" → Stellar Expert | ✅ |
| Lifecycle section, five steps | ✅ |
| All interactive elements carry an accessible name | ✅ 5/5 |
| No horizontal overflow | ✅ |

### Console (`/console`)

| Item | Result |
| --- | --- |
| Direct URL load (SPA rewrite) | ✅ desktop and mobile, local and production |
| Telemetry bar — latency, ledger, resting collateral, vault chip | ✅ |
| Vault chip resolves to V2 and links to the explorer | ✅ |
| Limit / Stop-loss segmented control | ✅ |
| TRY bridge tab | ✅ |
| Limit order form renders and computes the settlement preview | ✅ |
| Stop form: collateral, trigger, minimum, bounty, expiry | ✅ |
| Stop form shows the contract's size cap, read from `get_config` | ✅ "accepts at most 10." |
| Stop form shows the live feed price beside the trigger | ✅ |
| Persistent-trigger disclosure on the form | ✅ |
| Order queue reads all four deployments | ✅ 12 active / 8 settled |
| Active / Settled filters | ✅ 12 ↔ 8 |
| Refresh button | ✅ count stable, no errors |
| Version labels (V0·#n … V3·#n) | ✅ |
| "V3 could not be read" banner absent when V3 answers | ✅ |
| Stop card states — Watching, trigger level, deadline, "Nothing is sold yet" | ✅ |
| Wallet-gated form overlay when disconnected | ✅ |
| Connect button reaches Freighter | ⚠️ extension not installed in the test browser — see §4 |
| All interactive elements carry an accessible name | ✅ 49/49 |
| No horizontal overflow at 1024px | ✅ |
| No console errors across the full pass | ✅ |

### Mobile (375 × 812)

| Item | Result |
| --- | --- |
| No page-level horizontal overflow | ✅ document width = viewport width |
| Lifecycle stepper labels fit their columns | 🔧 "Ledger Confirmation" clipped by 5px — fixed by wrapping |
| Order cards, telemetry, forms | ✅ |
| Touch targets | ✅ the two elements under 28px tall are inline text links, 138px and 343px wide |

### Anchor (SEP-1 / 6 / 10 / 38)

| Item | Result |
| --- | --- |
| SEP-1 discovery from the new production origin | ✅ HTTP 200, `ACAO: *` |
| SEP-6 `/info` — deposit and withdraw rails | ✅ USDC both ways; limits 50–3000 TRY surfaced in the UI |
| SEP-10 challenge endpoint | ✅ HTTP 200; challenge validated against every assertion |
| SEP-38 indicative quote | ✅ 1 USDC = 48.7851 TRY, anchor fee 2.49 TRY |
| CORS preflight from the new origin | ✅ `Content-Type, Authorization` allowed; nothing loosened |
| Soroban RPC / Horizon CORS from the new origin | ✅ origin echoed |
| Discovery still works after the TOML parser hardening | ✅ re-verified in the browser |
| Polling stops at a terminal status | ✅ terminal set, 5-minute ceiling, cancel on unmount |
| Deposit / withdraw with a real signature | ⚠️ requires Freighter — see §4 |

### Contracts and keeper

| Item | Result |
| --- | --- |
| V2 tests | ✅ 17/17 |
| V3 tests | ✅ 34/34 |
| V3 on-chain wasm matches the local build | ✅ byte-identical, `4ced7ccf…4377d8` |
| V3 constructor read back from chain | ✅ all 13 fields match the manifest |
| `current_price()` against the live feed | ✅ returns a live cross rate |
| Guard simulations against the live contract | ✅ 7 refusals + 1 accepting path, nothing written |
| `get_order_count` unchanged by simulations | ✅ still the one live order |
| Keeper builds | ✅ |
| Keeper read-only mode sends nothing | ✅ every send path gated on a keypair, twice |
| Independent keeper execution | ⚠️ never demonstrated — see §4 |

---

## 2. Bugs found and fixed

| # | Severity | What | Commit |
| --- | --- | --- | --- |
| 1 | Medium | A slow balance read could write under a newly switched wallet, feeding the Max button and the funds check a stale number | `4861825` |
| 2 | Medium | Landing page described a limit-order-only product and claimed keeper automation that has never been demonstrated | `769ef4b` |
| 3 | Medium | README stated the stop-price rule backwards, claimed only the newest vault accepts orders, and said collateral "never leaves the contract" | `d7d02e9` |
| 4 | Low–Medium | SEP-10 challenge was not bound to the connected wallet, and `web_auth_domain` was unverified | `77723e8` |
| 5 | Low | TOML reader's prototype safety was an accident of upper-casing | `f4d7933` |
| 6 | Low | "Ledger Confirmation" clipped its column at 375px | `70b9bb8` |

Detail on 4 and 5, and on why 2 and 3 are treated as security-relevant, is in
[`SECURITY_REVIEW.md`](SECURITY_REVIEW.md).

---

## 3. Automated results

| Suite | Result |
| --- | --- |
| `contracts/vault` | 17 passed |
| `contracts/stop_vault` | 34 passed |
| `frontend` `tsc -b` | clean |
| `frontend` `vite build` | clean |
| `frontend` `oxlint` | 6 warnings, all pre-existing in the older anchor files, unchanged |
| `frontend` `vitest` | 23 passed (new) |
| `keeper` `tsc` | clean |

The 23 frontend tests are new. They cover the parsers that turn contract data into a claim on
screen, and every SEP-10 challenge assertion. The SEP-10 client-account check was
mutation-tested: disabling it fails exactly one test.

---

## 4. Not verified

Each of these is a real gap, not a formality.

- **Anything requiring a Freighter signature.** Order creation, trigger, execute, cancel,
  SEP-10 sign-in, SEP-6 deposit and withdraw. Reviewed by reading the code and by
  simulation against the live contracts; not exercised by signing. No attempt was made to
  bypass the wallet.
- **Wallet connection UI.** Freighter is not installed in the review browser. Known,
  pre-existing behaviour: with no extension present, the Connect button stays on
  "Connecting" indefinitely, because `requestAccess()` never settles. The application's own
  error path is correct; the library call does not return. Not fixed — it sits in the wallet
  flow, which was out of scope for this pass, and it affects only visitors without the
  extension this dApp requires.
- **Account switching and signature rejection mid-flight.** The code paths were read and the
  stale-write race was fixed; the flows were not driven.
- **Independent keeper execution.** Never run with a signing key.
- **A real price fall driving a V3 stop to settlement.** The one live stop order is Armed at
  0.1700 while the feed sits near 0.189; it needs roughly a 10% fall.
- **Third-party failure modes.** RPC, Horizon, Soroswap, Reflector, the anchor and Vercel
  were exercised only by ordinary reads, deliberately.

---

## 5. State

| | |
| --- | --- |
| Rollback point | `e2afb18` on `main` |
| Branch | `qa-hardening`, seven commits |
| Contracts | unchanged — **no redeploy required by anything in this report** |
| Existing orders | untouched; V0/V1/V2/V3 all still readable and cancellable |
| Production | see [`FINAL_REVIEW.md`](FINAL_REVIEW.md) for the deployment outcome |
