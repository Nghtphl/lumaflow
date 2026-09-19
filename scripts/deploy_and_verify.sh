#!/usr/bin/env bash
#
# TriggerVault — build, deploy and prove one real Soroswap execution on testnet.
#
# Run this from YOUR OWN terminal (it needs network access to Stellar testnet).
#   chmod +x scripts/deploy_and_verify.sh
#   ./scripts/deploy_and_verify.sh
#
# Every step is independently runnable — if one fails, the command it ran is
# printed so you can debug it by hand instead of re-running the whole script.
#
# Overrides:
#   SOROSWAP_ROUTER=C...   router address (default: published testnet router)
#   TOKEN_IN=C...          default: native XLM SAC
#   TOKEN_OUT=C...         skip pool discovery and use this token
#   IDENTITY=name          stellar keys identity to use (default: trigger-deployer)
#   AMOUNT_IN=<stroops>    default: 10 XLM
#   SKIP_DEPLOY=1          reuse VAULT_ID from the environment instead of deploying

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-trigger-deployer}"
SOROSWAP_ROUTER="${SOROSWAP_ROUTER:-CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD}"
SOROSWAP_FACTORY="${SOROSWAP_FACTORY:-CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY}"
AMOUNT_IN="${AMOUNT_IN:-100000000}"   # 10.0000000 XLM
FEE_BPS="${FEE_BPS:-100}"             # 1% keeper bounty

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Runs a read-only contract call and echoes the raw result.
read_call() {
  stellar contract invoke --id "$1" --source "$IDENTITY" --network "$NETWORK" --send=no -- "${@:2}" 2>/dev/null
}

# ---------------------------------------------------------------------------
say "0/8 Prerequisites"
command -v stellar >/dev/null || die "stellar CLI not found. Install: brew install stellar-cli   (or: cargo install --locked stellar-cli)"
command -v cargo   >/dev/null || die "cargo not found. Install Rust: https://rustup.rs"
ok "stellar $(stellar --version 2>/dev/null | head -1)"

if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  say "Creating and funding identity '$IDENTITY'"
  stellar keys generate --global "$IDENTITY" --network "$NETWORK" --fund
fi
ACCOUNT="$(stellar keys address "$IDENTITY")"
ok "identity $IDENTITY = $ACCOUNT"

# ---------------------------------------------------------------------------
say "1/8 Unit tests (the auth regression test must pass before deploying)"
(cd contracts/vault && cargo test) || die "cargo test failed — fix the contract before deploying"
ok "tests green"

# ---------------------------------------------------------------------------
say "2/8 Build the wasm"
(cd contracts/vault && stellar contract build)
WASM="$(find contracts/vault/target -name 'trigger_vault.wasm' -path '*release*' | head -1)"
[ -n "$WASM" ] || die "built wasm not found under contracts/vault/target"
ok "wasm: $WASM ($(wc -c <"$WASM" | tr -d ' ') bytes)"

# ---------------------------------------------------------------------------
say "3/8 Deploy"
if [ "${SKIP_DEPLOY:-}" = "1" ]; then
  VAULT_ID="${VAULT_ID:?SKIP_DEPLOY=1 requires VAULT_ID}"
  ok "reusing $VAULT_ID"
else
  VAULT_ID="$(stellar contract deploy --wasm "$WASM" --source "$IDENTITY" --network "$NETWORK" | tail -1 | tr -d '\r')"
  [ -n "$VAULT_ID" ] || die "deploy produced no contract id"
  ok "vault deployed: $VAULT_ID"
fi

# ---------------------------------------------------------------------------
say "4/8 Initialize with the Soroswap router"
if stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" --network "$NETWORK" \
     -- init --admin "$ACCOUNT" --router "$SOROSWAP_ROUTER" 2>&1 | tee /tmp/tv_init.log | tail -2; then
  ok "initialized (admin=$ACCOUNT, router=$SOROSWAP_ROUTER)"
else
  grep -q "AlreadyInitialized" /tmp/tv_init.log && warn "already initialized — continuing" || die "init failed (see /tmp/tv_init.log)"
fi

ROUTER_ONCHAIN="$(read_call "$VAULT_ID" get_router | tr -d '"')"
ok "get_router → $ROUTER_ONCHAIN"
[ "$ROUTER_ONCHAIN" = "$SOROSWAP_ROUTER" ] || die "router mismatch — run: stellar contract invoke --id $VAULT_ID --source $IDENTITY --network $NETWORK -- set_router --router $SOROSWAP_ROUTER"

# ---------------------------------------------------------------------------
say "5/8 Find a Soroswap pool with liquidity"
TOKEN_IN="${TOKEN_IN:-$(stellar contract id asset --asset native --network "$NETWORK")}"
ok "token_in (XLM SAC): $TOKEN_IN"

if [ -z "${TOKEN_OUT:-}" ]; then
  PAIR_COUNT="$(read_call "$SOROSWAP_FACTORY" all_pairs_length | tr -d '"' || true)"
  case "$PAIR_COUNT" in (*[!0-9]*|"") PAIR_COUNT=0 ;; esac
  ok "factory reports $PAIR_COUNT pairs"
  MAX=$PAIR_COUNT; [ "$MAX" -gt 40 ] && MAX=40
  i=0
  while [ "$i" -lt "$MAX" ]; do
    PAIR="$(read_call "$SOROSWAP_FACTORY" all_pairs --n "$i" | tr -d '"')" || PAIR=""
    i=$(( i + 1 ))
    [ -n "$PAIR" ] || continue
    T0="$(read_call "$PAIR" token_0 | tr -d '"')" || continue
    T1="$(read_call "$PAIR" token_1 | tr -d '"')" || continue
    if [ "$T0" = "$TOKEN_IN" ]; then CANDIDATE="$T1"
    elif [ "$T1" = "$TOKEN_IN" ]; then CANDIDATE="$T0"
    else continue; fi
    RESERVES="$(read_call "$PAIR" get_reserves)" || continue
    case "$RESERVES" in (*'"0"'*) warn "pair has an empty reserve, skipping"; continue ;; esac
    TOKEN_OUT="$CANDIDATE"
    ok "found pool $PAIR — token_out: $TOKEN_OUT (reserves: $RESERVES)"
    break
  done
fi

[ -n "${TOKEN_OUT:-}" ] || die "no XLM pool with liquidity found on this router.
  Either pass one explicitly:   TOKEN_OUT=C... ./scripts/deploy_and_verify.sh
  or bootstrap your own pool:   see docs/TESTNET_RUNBOOK.md §5 (create_pair + add_liquidity)"

PAIR_ADDR="$(read_call "$SOROSWAP_ROUTER" router_pair_for --token_a "$TOKEN_IN" --token_b "$TOKEN_OUT" | tr -d '"')"
ok "router_pair_for → $PAIR_ADDR   (this is the address execute_order authorizes)"

# ---------------------------------------------------------------------------
say "6/8 Quote the swap and pick min_amount_out"
AMOUNTS="$(read_call "$SOROSWAP_ROUTER" router_get_amounts_out --amount_in "$AMOUNT_IN" --path "[\"$TOKEN_IN\",\"$TOKEN_OUT\"]")"
ok "router_get_amounts_out → $AMOUNTS"
EXPECTED_OUT="$(printf '%s' "$AMOUNTS" | tr -dc '0-9,' | tr ',' '\n' | tail -1)"
[ -n "$EXPECTED_OUT" ] && [ "$EXPECTED_OUT" != "0" ] || die "could not quote the swap — check pool liquidity"
MIN_OUT=$(( EXPECTED_OUT * 95 / 100 ))   # 5% headroom so the demo is not lost to a tick of price movement
ok "expected out $EXPECTED_OUT → min_amount_out $MIN_OUT"

# ---------------------------------------------------------------------------
say "7/8 Create and execute one real order"
CREATE_LOG="$(mktemp)"
stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" --network "$NETWORK" \
  -- create_order --owner "$ACCOUNT" --token_in "$TOKEN_IN" --token_out "$TOKEN_OUT" \
     --amount_in "$AMOUNT_IN" --min_amount_out "$MIN_OUT" --fee_bps "$FEE_BPS" 2>&1 | tee "$CREATE_LOG"
ORDER_ID="$(read_call "$VAULT_ID" get_order_count | tr -d '"')"
ok "order #$ORDER_ID created"

EXEC_LOG="$(mktemp)"
stellar contract invoke --id "$VAULT_ID" --source "$IDENTITY" --network "$NETWORK" \
  -- execute_order --order_id "$ORDER_ID" --executor "$ACCOUNT" 2>&1 | tee "$EXEC_LOG"

EXEC_HASH="$(grep -oE '[0-9a-f]{64}' "$EXEC_LOG" | head -1 || true)"
STATUS="$(read_call "$VAULT_ID" get_order --order_id "$ORDER_ID")"
case "$STATUS" in
  *Executed*) ok "order #$ORDER_ID is Executed on chain" ;;
  *) die "order did not reach Executed. State: $STATUS   (log: $EXEC_LOG)" ;;
esac

# ---------------------------------------------------------------------------
say "8/8 Wire the new contract id into the app"
mkdir -p frontend
cat > frontend/.env.local <<EOF
VITE_VAULT_CONTRACT_ID=$VAULT_ID
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_TOKEN_OUT_CONTRACT_ID=$TOKEN_OUT
EOF
ok "wrote frontend/.env.local"

# Keep the hardcoded fallback in App.tsx honest too.
if [ -f frontend/src/App.tsx ]; then
  python3 - "$VAULT_ID" <<'PYEOF'
import re, sys
new_id = sys.argv[1]
path = "frontend/src/App.tsx"
src = open(path).read()
# Only the fallback literal that follows the VITE_VAULT_CONTRACT_ID lookup.
patched, n = re.subn(
    r'(VITE_VAULT_CONTRACT_ID \|\|\s*\n\s*")C[A-Z2-7]{55}(")',
    lambda m: m.group(1) + new_id + m.group(2), src, count=1)
if n:
    open(path, "w").write(patched)
    print("    updated frontend/src/App.tsx fallback contract id")
else:
    print("    ! could not patch App.tsx automatically — set VITE_VAULT_CONTRACT_ID in .env.local")
PYEOF
fi

for f in keeper/.env keeper/.env.example; do
  [ -f "$f" ] || continue
  perl -pi -e "s|^VAULT_CONTRACT_ID=.*|VAULT_CONTRACT_ID=\"$VAULT_ID\"|" "$f"
  ok "updated $f"
done

cat <<EOF

────────────────────────────────────────────────────────────────────────────
  VAULT CONTRACT ID : $VAULT_ID
  ROUTER (Soroswap) : $SOROSWAP_ROUTER
  PAIR              : $PAIR_ADDR
  TOKEN IN / OUT    : $TOKEN_IN / $TOKEN_OUT
  EXECUTED ORDER    : #$ORDER_ID
  EXECUTION TX      : ${EXEC_HASH:-see the explorer link below}

  Contract  https://stellar.expert/explorer/testnet/contract/$VAULT_ID
  Tx        ${EXEC_HASH:+https://stellar.expert/explorer/testnet/tx/$EXEC_HASH}

  Open the contract page and confirm the execute_order invocation shows
  sub-invocations into the router, the pair and both token contracts — that
  is the proof the integration is real. Put this contract id and tx hash in
  the README and on the submission form.
────────────────────────────────────────────────────────────────────────────
EOF
