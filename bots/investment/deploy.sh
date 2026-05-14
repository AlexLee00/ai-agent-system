#!/usr/bin/env bash
set -euo pipefail

# Luna Phase 2 FinRL-X deployment-consistent entrypoint.
# Usage: bots/investment/deploy.sh --mode backtest|paper|live [--apply] [--confirm=...]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_MODE="backtest"
APPLY="false"
CONFIRM=""
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --mode=*) DEPLOY_MODE="${arg#--mode=}" ;;
    --apply) APPLY="true" ;;
    --confirm=*) CONFIRM="${arg#--confirm=}" ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

case "$DEPLOY_MODE" in
  backtest)
    if [[ "$APPLY" == "true" ]]; then
      if [[ "$CONFIRM" != "luna-phase2-backtest" ]]; then
        echo "backtest apply requires --confirm=luna-phase2-backtest" >&2
        exit 2
      fi
      npm --prefix "$ROOT_DIR" run -s runtime:luna-candidate-backtest-refresh -- --json "${EXTRA_ARGS[@]}"
    else
      npm --prefix "$ROOT_DIR" run -s runtime:luna-candidate-backtest-refresh -- --json --dry-run "${EXTRA_ARGS[@]}"
    fi
    ;;
  paper)
    if [[ "$APPLY" == "true" ]]; then
      if [[ "$CONFIRM" != "luna-phase2-paper" ]]; then
        echo "paper apply requires --confirm=luna-phase2-paper" >&2
        exit 2
      fi
      npm --prefix "$ROOT_DIR" run -s runtime:luna-weight-vector-shadow -- --json --apply --confirm=luna-weight-vector-shadow "${EXTRA_ARGS[@]}"
      npm --prefix "$ROOT_DIR" run -s runtime:luna-paper-trading-shadow -- --json --apply --confirm=luna-paper-trading-shadow "${EXTRA_ARGS[@]}"
    else
      npm --prefix "$ROOT_DIR" run -s runtime:luna-weight-vector-shadow -- --json --dry-run "${EXTRA_ARGS[@]}"
      npm --prefix "$ROOT_DIR" run -s runtime:luna-paper-trading-shadow -- --json --dry-run "${EXTRA_ARGS[@]}"
    fi
    ;;
  live)
    if [[ "${LUNA_PHASE2_LIVE_DEPLOY_ENABLED:-false}" != "true" || "$CONFIRM" != "luna-phase2-live" ]]; then
      echo "live deploy is blocked: requires LUNA_PHASE2_LIVE_DEPLOY_ENABLED=true and --confirm=luna-phase2-live" >&2
      exit 2
    fi
    echo "live deploy gate passed, but Phase 2 does not execute live orders from deploy.sh" >&2
    exit 2
    ;;
  *)
    echo "invalid --mode backtest|paper|live" >&2
    exit 2
    ;;
esac
