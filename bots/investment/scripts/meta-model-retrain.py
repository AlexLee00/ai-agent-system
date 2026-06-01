#!/usr/bin/env python3
"""
루나 Secondary Model — 자동 재학습/Tier 판정/안전 교체 오케스트레이터.

SHADOW 원칙:
  - LUNA_META_MODEL_ENABLED=false(기본)면 전체 미실행.
  - 예측/진입 차단 로직은 변경하지 않는다.
  - active=true 교체는 AUC 회귀 방지 조건을 통과할 때만 수행한다.
"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import io
import json
import logging
import math
import os
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

TRUE_VALUES = {'1', 'true', 'yes', 'on', 't'}
ENABLED = os.environ.get('LUNA_META_MODEL_ENABLED', 'false').strip().lower() in TRUE_VALUES
RETRAIN_DELTA = int(os.environ.get('LUNA_META_MODEL_RETRAIN_DELTA', '50'))
TIER2_MIN = int(os.environ.get('LUNA_META_MODEL_TIER2_MIN', '500'))
TIER3_MARKET_MIN = int(os.environ.get('LUNA_META_MODEL_TIER3_MARKET_MIN', '200'))
MIN_AUC = float(os.environ.get('LUNA_META_MODEL_MIN_AUC', '0.5'))
PSQL_DB = os.environ.get('PGDATABASE', 'jay')

_SCRIPTS_DIR = Path(__file__).parent


@dataclass(frozen=True)
class TierDecision:
    tier: int
    model_type: str
    desired_tier: int
    tier3_ready: bool
    reason: str


def _load(module_name: str, filename: str):
    path = _SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _psql_args() -> List[str]:
    explicit_dsn = os.environ.get('PG_DSN')
    if explicit_dsn:
        return ['psql', explicit_dsn]
    return ['psql', '-d', PSQL_DB]


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _psql_rows(sql: str) -> List[dict]:
    query = sql.strip().rstrip(';')
    copy_sql = f"COPY ({query}) TO STDOUT WITH CSV HEADER"
    proc = subprocess.run(
        _psql_args() + ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', copy_sql],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            '[meta-model-retrain] psql 조회 실패: '
            f'{(proc.stderr or proc.stdout).strip()}'
        )
    if not proc.stdout.strip():
        return []
    return list(csv.DictReader(io.StringIO(proc.stdout)))


def _psql_exec(sql: str) -> None:
    proc = subprocess.run(
        _psql_args() + ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            '[meta-model-retrain] psql 실행 실패: '
            f'{(proc.stderr or proc.stdout).strip()}'
        )


def _to_int(value: Optional[str]) -> Optional[int]:
    if value in (None, ''):
        return None
    return int(float(value))


def _to_float(value: Optional[str]) -> Optional[float]:
    if value in (None, ''):
        return None
    return float(value)


def latest_model_version() -> Optional[dict]:
    rows = _psql_rows(
        """
        SELECT id, version, n_trades, tier, model_type, auc, precision_score, active
        FROM investment.luna_meta_model_versions
        ORDER BY trained_at DESC, id DESC
        LIMIT 1
        """
    )
    if not rows:
        return None
    row = rows[0]
    return {
        **row,
        'id': _to_int(row.get('id')),
        'n_trades': _to_int(row.get('n_trades')),
        'tier': _to_int(row.get('tier')),
        'auc': _to_float(row.get('auc')),
        'precision_score': _to_float(row.get('precision_score')),
        'active': str(row.get('active')).lower() in TRUE_VALUES,
    }


def active_model_version() -> Optional[dict]:
    rows = _psql_rows(
        """
        SELECT id, version, n_trades, tier, model_type, auc, precision_score, active
        FROM investment.luna_meta_model_versions
        WHERE active = true
        ORDER BY trained_at DESC, id DESC
        LIMIT 1
        """
    )
    if not rows:
        return None
    row = rows[0]
    return {
        **row,
        'id': _to_int(row.get('id')),
        'n_trades': _to_int(row.get('n_trades')),
        'tier': _to_int(row.get('tier')),
        'auc': _to_float(row.get('auc')),
        'precision_score': _to_float(row.get('precision_score')),
        'active': True,
    }


def training_market_counts() -> Dict[str, int]:
    rows = _psql_rows(
        """
        SELECT COALESCE(market, 'unknown') AS market, count(*) AS n
        FROM investment.trade_journal
        WHERE COALESCE(exclude_from_learning, false) = false
          AND exit_reason = 'normal_exit'
          AND pnl_net IS NOT NULL
        GROUP BY 1
        ORDER BY 1
        """
    )
    return {str(row['market']): int(row['n']) for row in rows}


def should_retrain(current_n: int, latest_n: Optional[int], retrain_delta: int) -> Tuple[bool, str]:
    if latest_n is None:
        return True, 'no_previous_model'
    delta = current_n - latest_n
    if delta >= retrain_delta:
        return True, f'delta_reached(current={current_n},latest={latest_n},delta={delta},threshold={retrain_delta})'
    return False, f'delta_below_threshold(current={current_n},latest={latest_n},delta={delta},threshold={retrain_delta})'


def decide_tier(
    n_trades: int,
    market_counts: Dict[str, int],
    tier2_min: int,
    tier3_market_min: int,
) -> TierDecision:
    max_market = max(market_counts.values(), default=0)
    tier3_ready = max_market >= tier3_market_min
    if n_trades >= tier2_min:
        base = TierDecision(
            tier=2,
            model_type='random_forest',
            desired_tier=2,
            tier3_ready=tier3_ready,
            reason=f'n_trades({n_trades})>=tier2_min({tier2_min})',
        )
    else:
        base = TierDecision(
            tier=1,
            model_type='logistic',
            desired_tier=1,
            tier3_ready=tier3_ready,
            reason=f'n_trades({n_trades})<tier2_min({tier2_min})',
        )
    if tier3_ready:
        return TierDecision(
            tier=base.tier,
            model_type=base.model_type,
            desired_tier=3,
            tier3_ready=True,
            reason=(
                f'{base.reason}; tier3_ready(max_market={max_market},'
                f'threshold={tier3_market_min}) but stage2_2_uses_tier{base.tier}'
            ),
        )
    return base


def should_activate(new_auc: Optional[float], active_auc: Optional[float], min_auc: float) -> Tuple[bool, str]:
    if new_auc is None or math.isnan(new_auc):
        return False, 'new_auc_missing'
    if new_auc <= min_auc:
        return False, f'new_auc_below_min({new_auc:.6f}<={min_auc:.6f})'
    if active_auc is None or math.isnan(active_auc):
        return True, f'no_active_model_and_new_auc_ok({new_auc:.6f}>{min_auc:.6f})'
    if new_auc >= active_auc:
        return True, f'new_auc_not_regressed({new_auc:.6f}>={active_auc:.6f})'
    return False, f'new_auc_regressed({new_auc:.6f}<{active_auc:.6f})'


def activate_version(version: str) -> None:
    literal = _sql_literal(version)
    _psql_exec(
        'BEGIN; '
        'UPDATE investment.luna_meta_model_versions SET active = false WHERE active = true; '
        f'UPDATE investment.luna_meta_model_versions SET active = true WHERE version = {literal}; '
        'COMMIT;'
    )


def orchestrate(dry_run: bool = False) -> dict:
    if not ENABLED:
        return {
            'ok': True,
            'action': 'skipped',
            'reason': 'LUNA_META_MODEL_ENABLED=false',
            'dryRun': dry_run,
        }

    dataset_mod = _load('meta_model_dataset', 'meta-model-dataset.py')
    train_mod = _load('meta_model_train', 'meta-model-train.py')

    X, y, feature_names, entry_times = dataset_mod.build_dataset()
    current_n = len(y)
    if current_n == 0:
        return {'ok': True, 'action': 'skipped', 'reason': 'dataset_empty', 'dryRun': dry_run}

    latest = latest_model_version()
    trigger, trigger_reason = should_retrain(
        current_n,
        latest.get('n_trades') if latest else None,
        RETRAIN_DELTA,
    )
    if not trigger:
        return {
            'ok': True,
            'action': 'skipped',
            'reason': trigger_reason,
            'currentTrades': current_n,
            'latest': latest,
            'dryRun': dry_run,
        }

    market_counts = training_market_counts()
    tier = decide_tier(current_n, market_counts, TIER2_MIN, TIER3_MARKET_MIN)
    notes = (
        f'SHADOW retrain — trigger={trigger_reason}; '
        f'tier={tier.tier}; desired_tier={tier.desired_tier}; reason={tier.reason}'
    )
    metrics = train_mod.train_and_save(
        X,
        y,
        feature_names,
        entry_times,
        dry_run=dry_run,
        model_type=tier.model_type,
        tier=tier.tier,
        notes=notes,
    )
    if metrics is None:
        return {
            'ok': True,
            'action': 'skipped',
            'reason': 'train_skipped_min_trades',
            'currentTrades': current_n,
            'tierDecision': asdict(tier),
            'dryRun': dry_run,
        }

    active = active_model_version() if not dry_run else None
    active_auc = active.get('auc') if active else None
    activate, activate_reason = should_activate(metrics.get('auc'), active_auc, MIN_AUC)
    if activate and not dry_run and metrics.get('version'):
        activate_version(str(metrics['version']))

    return {
        'ok': True,
        'action': 'trained',
        'triggerReason': trigger_reason,
        'currentTrades': current_n,
        'marketCounts': market_counts,
        'tierDecision': asdict(tier),
        'metrics': metrics,
        'activeBefore': active,
        'activated': bool(activate and not dry_run),
        'activationDecision': {
            'wouldActivate': activate,
            'reason': activate_reason,
            'minAuc': MIN_AUC,
            'activeAuc': active_auc,
        },
        'dryRun': dry_run,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Luna secondary meta-model retrain orchestrator')
    parser.add_argument('--dry-run', action='store_true', help='학습은 dry-run으로 수행하고 파일/DB 저장/active 교체를 건너뜀')
    parser.add_argument('--json', action='store_true', help='결과를 JSON으로 출력')
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    result = orchestrate(dry_run=args.dry_run)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return
    print(f"[meta-model-retrain] action={result.get('action')} reason={result.get('reason') or result.get('triggerReason')}")


if __name__ == '__main__':
    main()
