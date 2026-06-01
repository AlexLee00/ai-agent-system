#!/usr/bin/env python3
"""
루나 Secondary Model Stage 2-2 dry test.

검증 시나리오:
  A. retrain delta 미달 → skip
  B. retrain delta 도달 → dry-run 학습 가능
  C. Tier 1→2 전환 및 Tier 3 구조 pending
  D. active 교체 회귀 방지
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
logger = logging.getLogger(__name__)

os.environ.setdefault('LUNA_META_MODEL_ENABLED', 'true')
os.environ.setdefault('LUNA_META_MODEL_MIN_TRADES', '50')
os.environ.setdefault('LUNA_META_MODEL_TEST_RATIO', '0.25')
os.environ.setdefault('LUNA_META_MODEL_RANDOM_STATE', '42')
os.environ.setdefault('LUNA_META_MODEL_RETRAIN_DELTA', '50')
os.environ.setdefault('LUNA_META_MODEL_TIER2_MIN', '500')
os.environ.setdefault('LUNA_META_MODEL_TIER3_MARKET_MIN', '200')
os.environ.setdefault('LUNA_META_MODEL_MIN_AUC', '0.5')
os.environ.setdefault('LUNA_META_MODEL_RF_N_ESTIMATORS', '20')
os.environ.setdefault('LUNA_META_MODEL_RF_MAX_DEPTH', '4')
os.environ.setdefault('LUNA_META_MODEL_RF_MIN_SAMPLES_LEAF', '3')

_SCRIPTS_DIR = Path(__file__).parent


def _load(module_name: str, filename: str):
    path = _SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


def _synthetic_df(n: int, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    entry_times = [base + timedelta(hours=i * 4) for i in range(n)]
    confidence = rng.uniform(0.2, 1.0, size=n)
    sentiment = rng.uniform(-1.0, 1.0, size=n)
    noise = rng.normal(0.0, 0.08, size=n)
    pnl = (confidence - 0.55) * 0.05 + sentiment * 0.02 + noise
    return pd.DataFrame({
        'entry_time': entry_times,
        'market': rng.choice(['crypto', 'domestic', 'overseas'], size=n).tolist(),
        'direction': rng.choice(['long', 'short'], size=n).tolist(),
        'strategy_family': rng.choice(['momentum', 'breakout', 'mean_reversion'], size=n).tolist(),
        'market_regime': rng.choice(['trending', 'ranging', 'volatile', 'unknown'], size=n).tolist(),
        'market_regime_confidence': rng.uniform(0.4, 1.0, size=n).tolist(),
        'atr_at_entry': rng.uniform(0.001, 0.05, size=n).tolist(),
        'pnl_net': pnl.tolist(),
        'signal_confidence': confidence.tolist(),
        'signal_sentiment_score': sentiment.tolist(),
    })


def main() -> None:
    dataset_mod = _load('meta_model_dataset', 'meta-model-dataset.py')
    train_mod = _load('meta_model_train', 'meta-model-train.py')
    retrain_mod = _load('meta_model_retrain', 'meta-model-retrain.py')

    # A. 트리거 임계 미달 → skip
    trigger, reason = retrain_mod.should_retrain(current_n=140, latest_n=100, retrain_delta=50)
    assert trigger is False, f'임계 미달인데 trigger=true: {reason}'
    assert 'delta_below_threshold' in reason
    logger.info('[dry-test] ✓ A skip 판정: %s', reason)

    # B. 트리거 도달 → dry-run 학습 가능
    trigger, reason = retrain_mod.should_retrain(current_n=151, latest_n=100, retrain_delta=50)
    assert trigger is True, f'임계 도달인데 trigger=false: {reason}'
    X, y, names, times = dataset_mod.build_dataset_from_df(_synthetic_df(180, seed=100))
    metrics = train_mod.train_and_save(
        X, y, names, times,
        dry_run=True,
        model_type='logistic',
        tier=1,
        notes='dry-test',
    )
    assert metrics is not None and metrics['model_type'] == 'logistic' and metrics['tier'] == 1
    assert 'auc' in metrics and metrics['n_trades'] == 180
    logger.info('[dry-test] ✓ B dry-run 학습: AUC=%.4f', metrics['auc'])

    # C. Tier 1→2 전환 및 Tier 3 구조 pending
    tier1 = retrain_mod.decide_tier(499, {}, tier2_min=500, tier3_market_min=200)
    tier2 = retrain_mod.decide_tier(500, {}, tier2_min=500, tier3_market_min=200)
    tier3_pending = retrain_mod.decide_tier(700, {'crypto': 250}, tier2_min=500, tier3_market_min=200)
    assert tier1.tier == 1 and tier1.model_type == 'logistic'
    assert tier2.tier == 2 and tier2.model_type == 'random_forest'
    assert tier3_pending.desired_tier == 3 and tier3_pending.tier == 2 and tier3_pending.tier3_ready
    X2, y2, names2, times2 = dataset_mod.build_dataset_from_df(_synthetic_df(520, seed=200))
    rf_metrics = train_mod.train_and_save(
        X2, y2, names2, times2,
        dry_run=True,
        model_type=tier2.model_type,
        tier=tier2.tier,
        notes='dry-test-rf',
    )
    assert rf_metrics is not None and rf_metrics['model_type'] == 'random_forest' and rf_metrics['tier'] == 2
    logger.info('[dry-test] ✓ C Tier 전환: tier1=%s tier2=%s tier3_pending=%s', tier1, tier2, tier3_pending)

    # D. 교체 회귀 방지
    ok, why = retrain_mod.should_activate(new_auc=0.60, active_auc=0.70, min_auc=0.50)
    assert ok is False and 'regressed' in why
    ok, why = retrain_mod.should_activate(new_auc=0.55, active_auc=None, min_auc=0.50)
    assert ok is True and 'no_active_model' in why
    ok, why = retrain_mod.should_activate(new_auc=0.50, active_auc=None, min_auc=0.50)
    assert ok is False and 'below_min' in why
    logger.info('[dry-test] ✓ D 교체 회귀 방지')

    print('\n[meta-model-retrain-dry] 모든 검증 통과 ✓')
    print(f'  B logistic AUC={metrics["auc"]:.4f}')
    print(f'  C random_forest AUC={rf_metrics["auc"]:.4f}')
    print(f'  Tier3 구조: desired={tier3_pending.desired_tier}, effective={tier3_pending.tier}')


if __name__ == '__main__':
    main()
