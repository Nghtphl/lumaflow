# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

LumaFlow: non-custodial limit orders on Stellar Soroban, funded and cashed out in
Turkish lira through a SEP-6 anchor. Testnet only.

Three independent components, **no workspace or root `package.json`** — `cd` into the one
you are working on.

| Path | Stack | Role |
| --- | --- | --- |
| `contracts/vault/` | Rust, `soroban-sdk` 22, `#![no_std]` | The vault: escrow, swap, bounty |
| `frontend/` | React 19, Vite 8, Tailwind v4, TypeScript | dApp + the SEP anchor client |
| `keeper/` | Node, `tsx` | Polls for executable orders and settles them |

## Commands

**Contract** (`cd contracts/vault`)

```bash
cargo test                                            # 11 tests
cargo test test_execute_order_with_keeper_bounty      # one test by name
cargo test -- --nocapture                             # keep stdout
cargo build --release --target wasm32-unknown-unknown # deployable wasm
```

`cargo test` regenerates `test_snapshots/` — those are tracked, so commit the churn or
explain it.

**Frontend** (`cd frontend`)

```bash
npm run dev      # Vite on :5173
npm run build    # tsc -b && vite build — typecheck is part of the build
npm run lint     # oxlint
npx tsc -b       # typecheck alone
```

There is no test runner in `frontend/`. `tsc -b` plus `npm run lint` is the full gate.
`tsconfig.app.json` sets `noUnusedLocals`/`noUnusedParameters`, so a stray import fails
the build — but note `strict` is **not** enabled, so null-safety is not enforced.

**Keeper** (`cd keeper`)

```bash
npm start        # tsx src/index.ts — the script is `start`, not `dev`
npm run build    # tsc
```

Env: `RPC_URL` and `VAULT_CONTRACT_ID` are required; `KEEPER_SECRET_KEY` is optional and
its absence puts the bot in read-only scan mode. Also `NETWORK_PASSPHRASE`,
`POLL_INTERVAL_MS` (default 4000).

## Architecture

### The vault trusts its own balance, not the router

The invariant everything else is built around. `execute_order` reads the contract's
`token_out` balance before and after the swap and treats the **observed delta** as the
realised output; the transaction reverts unless that delta clears `min_amount_out`, and
the keeper bounty is computed from the delta alone (capped 1,000 bps).

This is why `src/test.rs` carries three router doubles: one that behaves (`PullingRouter`),
one that reports a good fill while delivering less (`MisreportingRouter`), and one that
pays out without taking the input (`NonPullingRouter`). Changing settlement means changing
those tests. Read `lib.rs` and `test.rs` together.

`min_amount_out` is a **limit-order boundary, not an oracle stop-loss**. There is no price
feed in this system; a stop-loss mode would need a trigger type and a trusted price source.

### USDC is two things at once

The same asset appears as a classic asset (issuer `G…`) and as a Stellar Asset Contract
(`C…`), and the frontend touches both:

- **Trustline** is a classic `changeTrust` through Horizon — `frontend/src/anchor/trustline.ts`
- **Balance** is read by simulating a SAC `balance` call through Soroban RPC — `fetchUsdcBalance` in `App.tsx`
- **Collateral** enters the vault as the SAC address

A wallet can hold USDC with no trustline visible to the SAC path, or vice versa. When a
balance looks wrong, work out which of the two representations you are reading.

Everything is 7-decimal integers end-to-end; format only at the UI edge. The constant is
named `STROOPS_PER_XLM` but is applied to every asset — the name is wrong, the maths is not.

### The anchor client is discovered, not configured

`VITE_ANCHOR_HOME_DOMAIN` is the only anchor input. From it:
`toml.ts` (SEP-1 discovery) → `sep10.ts` (Freighter-signed JWT) → `sep6.ts` (deposit/withdraw
rails, status ladder) → `sep38.ts` (TRY quotes) → `trustline.ts`. Limits and endpoints come
from the anchor's `/sep6/info`, never from constants. Keep it that way: portability to a
real anchor is a core claim of this project.

The live panel is **`frontend/src/components/AnchorPanel.tsx`**. `frontend/src/anchor/AnchorPanel.tsx`
is an unreferenced older copy — it still type-checks and lints, so do not mistake it for
the real one.

### Frontend state and routing

`App.tsx` owns all wallet, chain and order state. Routes do not receive it as props: the
console view is built as a JSX value inside `App` that closes over the state, and
`<Routes>` picks between it and `LandingPage`. Chain polling is gated on the console route
so the landing page makes no RPC calls.

`Navbar` is keyed by `location.pathname` so a route change remounts it rather than
unwinding the previous route's scroll-spy state by hand.

**One scroll offset only.** `base.css` sets `scroll-padding-top` on `html`. Do not also add
`scroll-mt-*` to sections — scroll-padding on the scroller and scroll-margin on the target
*add*, which pushes a section past the navbar's scroll-spy reading line and strands the
active highlight on the previous section.

### Design system

Tokens live in `frontend/src/styles/theme.css` as a strict 60/30/10 split: canvas (deep
desaturated navy), structure (steel grey hairlines and type), and a single blue accent.
Build from those tokens — `bg-surface`, `text-ink-3`, `border-line` — not raw Tailwind
palette classes.

Deliberately absent, and to stay absent: gradients, glows, coloured status dots, pulsing,
and any second accent hue. Depth comes from elevation and hairlines. Motion is GSAP with
one vocabulary in `lib/motion.ts` (four easing curves, five durations) and collapses under
`prefers-reduced-motion`.

## Soroban rules (from `.cursorrules`)

- Target `soroban-sdk` 22.0.0, Rust edition 2021, `#![no_std]`.
- Never `std` types. Use `soroban_sdk::{Address, Env, Symbol, Vec, Map, BytesN, symbol_short}`.
- Orders and protocol state go in `env.storage().persistent()`, and TTL must be managed
  (~120-day target, renewed under ~30 days). RPC *simulation* of a getter does not extend a
  TTL — only a state-changing transaction does.
- Permission checks are `address.require_auth()`. Authorize the router's pull through a
  scoped sub-invocation, never a blanket approval.
- Soroban is Stellar's native L1, not an L2 or rollup. No `msg.sender`; use
  `env.ledger().timestamp()`. Execution is reentrancy-safe within native contracts, so no
  reentrancy guards.

## Gotchas

- **One module per contract double in tests.** `#[contractimpl]` emits module-level symbols
  named after the *method* (`__swap_exact_tokens_for_tokens`, `__SPEC_XDR_FN_…`), not the
  contract type. Two doubles sharing a module redefine the same names and the test target
  stops compiling. `src/test.rs` wraps each router in its own `mod`; keep it that way.
- **Deploy is a git push.** The Vercel project is git-linked (root directory `frontend`), so
  a push to `main` is a production deploy. `frontend/vercel.json` holds the SPA rewrite
  without which `/console` 404s on direct load.
- `.env*` and `.vercel/` are gitignored; `frontend/.env.example` is the reference.

## Stellar Skills referenced in `README.md`

Cited by path, as the hackathon handbook requires:

| Skill file | Source | Used for |
| --- | --- | --- |
| `SKILL.md` | `CheesecakeLabs/stellar-anchor-skill` | The SEP-6/10/38 bridge in `frontend/src/anchor/` |
| `skills/standards/SKILL.md` | `stellar/stellar-dev-skill` | SEP-1 discovery, SEP-10 JWT, SEP-38 quotes |
| `skills/assets/SKILL.md` | `stellar/stellar-dev-skill` | `changeTrust` and the classic → SAC bridge |
| `skills/dapp/SKILL.md` | `stellar/stellar-dev-skill` | Freighter connection, network guard, signing |
| `skills/smart-contracts/SKILL.md` | `stellar/stellar-dev-skill` | Soroban storage, TTL, auth |

Index: <https://skills.stellar.org/>

## Reference docs

`docs/ARCHITECTURE.md` (flow and storage) · `docs/SPECIFICATION.md` (entrypoints, slippage
and TTL semantics) · `docs/ANCHOR_INTEGRATION.md` (SEP integration in depth, and the
submission requirements it feeds) · `docs/TESTNET_RUNBOOK.md` (deploy and invoke) ·
`docs/HACKATHON_READINESS.md` (submission checklist).
