#!/usr/bin/env python3
"""
루나 Secondary Model — Dry Test

합성 데이터(고정 시드)로 세 가지를 검증한다:
  1. 데이터셋 결정성: 동일 시드 → 동일 X, y, feature_names
  2. 누수 없음: test 집합 entry_time > train 집합 entry_time (시계열 split)
  3. 학습 결정성: random_state 고정 → 동일 AUC 재현

DB 접근 없음. 파일/DB 저장 없음 (dry_run=True).
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

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')

_SCRIPTS_DIR = Path(__file__).parent


def _load(module_name: str, filename: str):
    """하이픈 파일명을 importlib로 로드."""
    path = _SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _synthetic_df(n: int = 200, seed: int = 42) -> pd.DataFrame:
    """결정성 합성 데이터 생성 (고정 시드, entry_time 오름차순)."""
    rng = np.random.default_rng(seed)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    entry_times = [base + timedelta(hours=i * 4) for i in range(n)]

    return pd.DataFrame({
        'entry_time':               entry_times,
        'market':                   rng.choice(['crypto', 'domestic', 'overseas'], size=n).tolist(),
        'direction':                rng.choice(['long', 'short'], size=n).tolist(),
        'strategy_family':          rng.choice(['momentum', 'breakout', 'mean_reversion'], size=n).tolist(),
        'market_regime':            rng.choice(['trending', 'ranging', 'volatile', 'unknown'], size=n).tolist(),
        'market_regime_confidence': rng.uniform(0.4, 1.0, size=n).tolist(),
        'atr_at_entry':             rng.uniform(0.001, 0.05, size=n).tolist(),
        'pnl_net':                  rng.normal(0.001, 0.03, size=n).tolist(),
        'signal_confidence':        rng.uniform(0.5, 1.0, size=n).tolist(),
        'signal_sentiment_score':   rng.uniform(-1.0, 1.0, size=n).tolist(),
    })


def run_dry_test() -> None:
    # 환경변수 기본값 세팅 (미설정 시 기본값 사용 — 모듈 로드 전 적용)
    os.environ.setdefault('LUNA_META_MODEL_MIN_TRADES', '50')
    os.environ.setdefault('LUNA_META_MODEL_TEST_RATIO', '0.25')
    os.environ.setdefault('LUNA_META_MODEL_RANDOM_STATE', '42')
    os.environ.setdefault('LUNA_META_MODEL_TYPE', 'logistic')

    dataset_mod = _load('meta_model_dataset', 'meta-model-dataset.py')
    train_mod   = _load('meta_model_train',   'meta-model-train.py')

    # ── 1. 데이터셋 결정성: 동일 시드 → 동일 X, y ────────────────────────────
    df_a = _synthetic_df(200, seed=42)
    df_b = _synthetic_df(200, seed=42)
    X_a, y_a, names_a, times_a = dataset_mod.build_dataset_from_df(df_a)
    X_b, y_b, names_b, times_b = dataset_mod.build_dataset_from_df(df_b)

    assert np.array_equal(X_a, X_b),  '❌ 동일 시드 → X 불일치'
    assert np.array_equal(y_a, y_b),  '❌ 동일 시드 → y 불일치'
    assert names_a == names_b,         '❌ 동일 시드 → feature_names 불일치'
    logger.info('[dry-test] ✓ 데이터셋 결정성 확인 (X=%s, 피처=%d개)', X_a.shape, len(names_a))

    # ── 2. 누수 검증: test entry_time > train entry_time ──────────────────────
    _, _, _, _, times_train, times_test = train_mod.time_series_split(
        X_a, y_a, times_a, test_ratio=0.25,
    )
    assert len(times_train) > 0 and len(times_test) > 0, '❌ split 결과 비어 있음'
    assert max(times_train) < min(times_test), (
        f'❌ 누수 감지: train 최대({max(times_train)}) >= test 최소({min(times_test)})'
    )
    logger.info(
        '[dry-test] ✓ 누수 없음: train 최대=%s | test 최소=%s',
        max(times_train), min(times_test),
    )

    # ── 3. 학습 결정성: 동일 random_state → 동일 AUC ─────────────────────────
    metrics_a = train_mod.train_and_save(X_a, y_a, names_a, times_a, dry_run=True)
    metrics_b = train_mod.train_and_save(X_a, y_a, names_a, times_a, dry_run=True)

    assert metrics_a is not None, (
        '❌ 학습 skip — 합성 200건인데 MIN_TRADES 미달. '
        'LUNA_META_MODEL_MIN_TRADES 확인'
    )
    import math
    auc_a = metrics_a['auc']
    auc_b = metrics_b['auc']
    assert not math.isnan(auc_a), '❌ AUC=nan — test set 단일 클래스 (합성 데이터 확인)'
    assert abs(auc_a - auc_b) < 1e-10, (
        f'❌ random_state 고정인데 AUC 불일치: {auc_a} vs {auc_b}'
    )
    logger.info('[dry-test] ✓ 학습 결정성: AUC=%.4f (2회 동일)', auc_a)

    # ── 결과 요약 ─────────────────────────────────────────────────────────────
    print('\n[dry-test] 모든 검증 통과 ✓')
    print(f'  데이터셋: X shape={X_a.shape}, pos_rate={float(y_a.mean()):.3f}')
    print(f'  피처 수: {len(names_a)}')
    print(f'  split: train={len(times_train)} / test={len(times_test)}')
    print(
        f'  평가: AUC={auc_a:.4f} | '
        f'precision={metrics_a["precision"]:.4f} | '
        f'recall={metrics_a["recall"]:.4f} | '
        f'f1={metrics_a["f1"]:.4f}'
    )


if __name__ == '__main__':
    run_dry_test()
