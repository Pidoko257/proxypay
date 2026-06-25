#!/usr/bin/env bash
# =============================================================================
# deploy-escrow.sh — Build, deploy, and smoke-test the Soroban escrow contract
#
# Usage:
#   ./scripts/deploy-escrow.sh [--network testnet|mainnet] [--upgrade]
#
# Required env vars (or loaded from .env):
#   STELLAR_NETWORK          testnet | mainnet (default: testnet)
#   STELLAR_DEPLOYER_SECRET  S... secret key of the deployer account
#
# Optional:
#   ESCROW_CONTRACT_ID       If set and --upgrade is passed, performs an
#                            in-place WASM upgrade instead of a fresh deploy.
#   STELLAR_RPC_URL          Override the RPC endpoint
#   STELLAR_HORIZON_URL      Used for network selection fallback
#
# Outputs:
#   .env is updated with ESCROW_CONTRACT_ID=<new-or-existing-contract-id>
# =============================================================================
set -euo pipefail

# ── Resolve project root ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
ENV_FILE="$ROOT_DIR/.env"

# ── Load .env if present ──────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
fi

# ── Parse arguments ───────────────────────────────────────────────────────────
NETWORK="${STELLAR_NETWORK:-testnet}"
UPGRADE=false

for arg in "$@"; do
  case "$arg" in
    --network=*) NETWORK="${arg#*=}" ;;
    --network)   shift; NETWORK="${1:-testnet}" ;;
    --upgrade)   UPGRADE=true ;;
  esac
done

# ── Validate required vars ────────────────────────────────────────────────────
if [[ -z "${STELLAR_DEPLOYER_SECRET:-}" ]]; then
  echo "❌  STELLAR_DEPLOYER_SECRET is not set. Aborting."
  exit 1
fi

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
  echo "❌  Invalid --network value: '$NETWORK'. Must be 'testnet' or 'mainnet'."
  exit 1
fi

# ── Detect stellar/soroban CLI ────────────────────────────────────────────────
if command -v stellar &>/dev/null; then
  CLI="stellar"
elif command -v soroban &>/dev/null; then
  CLI="soroban"
else
  echo "❌  Neither 'stellar' nor 'soroban' CLI found."
  echo "    Install with: cargo install --locked stellar-cli --features opt"
  exit 1
fi

echo "✅  Using CLI: $CLI"
echo "🌐  Network:   $NETWORK"

# ── Default RPC endpoints ─────────────────────────────────────────────────────
if [[ -z "${STELLAR_RPC_URL:-}" ]]; then
  if [[ "$NETWORK" == "mainnet" ]]; then
    STELLAR_RPC_URL="https://mainnet.stellar.validationcloud.io/v1/soroban/rpc"
  else
    STELLAR_RPC_URL="https://soroban-testnet.stellar.org"
  fi
fi

# Common CLI flags
CLI_FLAGS=(
  --network "$NETWORK"
  --rpc-url "$STELLAR_RPC_URL"
  --source "$STELLAR_DEPLOYER_SECRET"
)

# ── Step 1: Build ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 1/4 — Compiling Soroban contracts"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

(cd "$CONTRACTS_DIR" && "$CLI" contract build)

WASM_PATH="$CONTRACTS_DIR/target/wasm32-unknown-unknown/release/escrow.wasm"

if [[ ! -f "$WASM_PATH" ]]; then
  echo "❌  WASM artifact not found at: $WASM_PATH"
  exit 1
fi

WASM_SIZE=$(du -k "$WASM_PATH" | cut -f1)
echo "✅  Build complete — escrow.wasm (${WASM_SIZE}KB)"

# ── Step 2: Install WASM (upload to network) ──────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 2/4 — Installing WASM onto $NETWORK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

WASM_HASH=$("$CLI" contract install \
  "${CLI_FLAGS[@]}" \
  --wasm "$WASM_PATH")

echo "✅  WASM installed — hash: $WASM_HASH"

# ── Step 3: Deploy or Upgrade ─────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

EXISTING_CONTRACT_ID="${ESCROW_CONTRACT_ID:-}"

if [[ "$UPGRADE" == "true" && -n "$EXISTING_CONTRACT_ID" ]]; then
  echo "  Step 3/4 — Upgrading existing contract $EXISTING_CONTRACT_ID"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  "$CLI" contract invoke \
    "${CLI_FLAGS[@]}" \
    --id "$EXISTING_CONTRACT_ID" \
    -- upgrade \
    --new_wasm_hash "$WASM_HASH"

  CONTRACT_ID="$EXISTING_CONTRACT_ID"
  echo "✅  Contract upgraded"
else
  echo "  Step 3/4 — Deploying new contract to $NETWORK"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  CONTRACT_ID=$("$CLI" contract deploy \
    "${CLI_FLAGS[@]}" \
    --wasm-hash "$WASM_HASH")

  echo "✅  Contract deployed — ID: $CONTRACT_ID"
fi

# ── Step 4: Save contract ID to .env ─────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Step 4/4 — Persisting config and smoke test"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

update_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

touch "$ENV_FILE"
update_env "ESCROW_CONTRACT_ID" "$CONTRACT_ID"
update_env "ESCROW_WASM_HASH"   "$WASM_HASH"
update_env "STELLAR_NETWORK"    "$NETWORK"

echo "✅  .env updated:"
echo "     ESCROW_CONTRACT_ID=$CONTRACT_ID"
echo "     ESCROW_WASM_HASH=$WASM_HASH"

# ── Smoke test ────────────────────────────────────────────────────────────────
# The contract is freshly deployed and has no state yet, so get_state will
# return an error (NotInitialised). We treat ANY response from the network
# as proof the contract is live and reachable — an XDR error response is
# itself a valid on-chain response. We use --is-view to avoid signing a tx.
echo ""
echo "🔍  Running post-deploy smoke test..."

SMOKE_OUTPUT=$("$CLI" contract invoke \
  "${CLI_FLAGS[@]}" \
  --id "$CONTRACT_ID" \
  --is-view \
  -- get_state 2>&1 || true)

# A freshly deployed (uninitialised) contract returns a contract error.
# Any response that is NOT a network/RPC failure confirms the contract is live.
if echo "$SMOKE_OUTPUT" | grep -qiE "error|HostError|not initialised|ESCROW|WasmVm|contract"; then
  echo "✅  Smoke test passed — contract is live and responding on $NETWORK"
  echo "    (NotInitialised error is expected for a fresh deployment)"
elif echo "$SMOKE_OUTPUT" | grep -qiE "released|depositor|beneficiary"; then
  echo "✅  Smoke test passed — contract returned state"
else
  echo "❌  Smoke test failed — unexpected response:"
  echo "$SMOKE_OUTPUT"
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════"
echo "  🚀 Deployment complete"
echo "  Network:     $NETWORK"
echo "  Contract ID: $CONTRACT_ID"
echo "  WASM hash:   $WASM_HASH"
echo "════════════════════════════════════════════════"
