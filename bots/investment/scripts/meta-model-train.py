#!/usr/bin/env python3
"""
루나 Secondary Model — Tier 1 학습, 저장, 버전 DB 기록

SHADOW 원칙: LUNA_META_MODEL_ENABLED=false(기본) → 학습 미실행.
기존 entry-trigger / refresh / backtest 동작 0 변경.
예측/진입 차단 없음 — 통계 기록만.

의존: numpy, pandas, scikit-learn, joblib, psycopg2-binary
"""

from __future__ import annotations

import importlib.util
import csv
import io
import json
import logging
import math
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple

import joblib
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, precision_score, recall_score, roc_auc_score

try:
    import psycopg2  # type: ignore
except ModuleNotFoundError:
    psycopg2 = None  # type: ignore

logger = logging.getLogger(__name__)

# ── 환경변수 (magic number 0) ──────────────────────────────────────────────────
ENABLED = os.environ.get('LUNA_META_MODEL_ENABLED', 'false').lower() == 'true'
MODEL_TYPE = os.environ.get('LUNA_META_MODEL_TYPE', 'logistic')
MIN_TRADES = int(os.environ.get('LUNA_META_MODEL_MIN_TRADES', '50'))
TEST_RATIO = float(os.environ.get('LUNA_META_MODEL_TEST_RATIO', '0.25'))
RANDOM_STATE = int(os.environ.get('LUNA_META_MODEL_RANDOM_STATE', '42'))

PG_DSN = os.environ.get('PG_DSN', 'dbname=jay')
PSQL_DB = os.environ.get('PGDATABASE', 'jay')

OUTPUT_DIR = Path(__file__).parent.parent / 'output' / 'meta-model'


def _psql_args() -> List[str]:
    """psycopg2가 없는 DEV 환경에서도 버전 기록을 남기기 위한 psql CLI fallback."""
    explicit_dsn = os.environ.get('PG_DSN')
    if explicit_dsn:
        return ['psql', explicit_dsn]
    return ['psql', '-d', PSQL_DB]


def _load_dataset_module():
    """meta-model-dataset.py를 importlib로 로드 (하이픈 파일명 대응)."""
    path = Path(__file__).parent / 'meta-model-dataset.py'
    spec = importlib.util.spec_from_file_location('meta_model_dataset', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def time_series_split(
    X: np.ndarray,
    y: np.ndarray,
    entry_times: List,
    test_ratio: float,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List, List]:
    """
    시계열 순서 split: 앞 (1-test_ratio) → train, 뒤 test_ratio → test.
    누수 방지: test가 항상 train 이후 (entry_time ASC 정렬 전제).
    """
    n = len(y)
    n_train = max(1, int(n * (1 - test_ratio)))
    return (
        X[:n_train], X[n_train:],
        y[:n_train], y[n_train:],
        entry_times[:n_train], entry_times[n_train:],
    )


def build_model(model_type: str, random_state: int) -> LogisticRegression:
    if model_type == 'logistic':
        return LogisticRegression(
            class_weight='balanced',
            random_state=random_state,
            max_iter=1000,
        )
    raise ValueError(
        f'지원하지 않는 모델 타입: {model_type!r}. '
        'LUNA_META_MODEL_TYPE 확인 (현재: logistic)'
    )


def evaluate(model: LogisticRegression, X_test: np.ndarray, y_test: np.ndarray) -> dict:
    """precision/recall/F1/AUC 반환. accuracy는 불균형 데이터에 부적합하므로 제외."""
    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    prec = float(precision_score(y_test, y_pred, zero_division=0))
    rec = float(recall_score(y_test, y_pred, zero_division=0))
    f1 = float(f1_score(y_test, y_pred, zero_division=0))

    try:
        auc = float(roc_auc_score(y_test, y_prob))
    except ValueError:
        auc = float('nan')
        logger.warning('[meta-model-train] test set 단일 클래스 → AUC 계산 불가')

    return {'precision': prec, 'recall': rec, 'f1': f1, 'auc': auc}


def _save_model(
    model: LogisticRegression,
    feature_names: List[str],
    metrics: dict,
    n_trades: int,
    version: str,
) -> Path:
    """모델을 타임스탬프 파일명으로 저장하고 경로를 반환."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    model_path = OUTPUT_DIR / f'meta-model-tier1-{version}.joblib'
    payload = {
        'model': model,
        'meta': {
            'version': version,
            'feature_names': feature_names,
            'metrics': metrics,
            'n_trades': n_trades,
            'model_type': MODEL_TYPE,
        },
    }
    joblib.dump(payload, model_path)
    logger.info('[meta-model-train] 모델 저장: %s', model_path)
    return model_path


def _record_version(
    model_path: Path,
    feature_names: List[str],
    metrics: dict,
    n_trades: int,
    version: str,
    tier: int = 1,
) -> None:
    """luna_meta_model_versions에 학습 결과를 기록한다. active=false (단계 2-2에서 교체)."""
    auc_val = None if math.isnan(metrics['auc']) else metrics['auc']
    if psycopg2 is not None:
        conn = psycopg2.connect(PG_DSN)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO investment.luna_meta_model_versions
                      (version, tier, model_type, n_trades,
                       auc, precision_score, recall_score, f1_score,
                       feature_names, model_path, active, notes)
                    VALUES (%s, %s, %s, %s,
                            %s, %s, %s, %s,
                            %s::jsonb, %s, false,
                            'SHADOW 학습 — 단계 2-1. 예측/진입 차단 없음.')
                    RETURNING id
                    """,
                    (
                        version, tier, MODEL_TYPE, n_trades,
                        auc_val, metrics['precision'], metrics['recall'], metrics['f1'],
                        json.dumps(feature_names), str(model_path),
                    ),
                )
                row_id = cur.fetchone()[0]
            conn.commit()
            logger.info('[meta-model-train] 버전 DB 기록 완료: id=%s version=%s', row_id, version)
        finally:
            conn.close()
        return

    logger.info('[meta-model-train] psycopg2 없음 → psql CLI fallback 사용')
    row = io.StringIO()
    writer = csv.writer(row, lineterminator='\n')
    writer.writerow([
        version,
        tier,
        MODEL_TYPE,
        n_trades,
        auc_val,
        metrics['precision'],
        metrics['recall'],
        metrics['f1'],
        json.dumps(feature_names),
        str(model_path),
        'false',
        'SHADOW 학습 — 단계 2-1. 예측/진입 차단 없음.',
    ])
    copy_script = (
        "\\copy investment.luna_meta_model_versions "
        "(version, tier, model_type, n_trades, auc, precision_score, recall_score, "
        "f1_score, feature_names, model_path, active, notes) "
        "FROM STDIN WITH CSV\n"
        f"{row.getvalue()}\\.\n"
    )
    proc = subprocess.run(
        _psql_args() + ['-X', '-q', '-v', 'ON_ERROR_STOP=1'],
        input=copy_script,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "[meta-model-train] psql 버전 기록 실패: "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    logger.info('[meta-model-train] 버전 DB 기록 완료: version=%s', version)


def train_and_save(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: List[str],
    entry_times: List,
    dry_run: bool = False,
) -> Optional[dict]:
    """
    데이터셋을 받아 학습→평가→저장→DB 기록 수행.
    dry_run=True 시 파일/DB 저장을 건너뜀 (test 전용).

    Returns:
      metrics dict (precision/recall/f1/auc), 또는
      None (MIN_TRADES 미달로 skip)
    """
    n = len(y)
    if n < MIN_TRADES:
        logger.warning(
            '[meta-model-train] 학습 skip: 가용 거래 %d건 < MIN_TRADES(%d). '
            'LUNA_META_MODEL_MIN_TRADES 조정 또는 데이터 누적 후 재시도.',
            n, MIN_TRADES,
        )
        return None

    X_train, X_test, y_train, y_test, times_train, times_test = time_series_split(
        X, y, entry_times, TEST_RATIO
    )

    logger.info(
        '[meta-model-train] split: train=%d(%s) test=%d(%s)',
        len(y_train), max(times_train) if times_train else 'N/A',
        len(y_test),  min(times_test)  if times_test  else 'N/A',
    )

    model = build_model(MODEL_TYPE, RANDOM_STATE)
    model.fit(X_train, y_train)
    metrics = evaluate(model, X_test, y_test)

    logger.info(
        '[meta-model-train] 평가: precision=%.3f recall=%.3f f1=%.3f auc=%s',
        metrics['precision'], metrics['recall'], metrics['f1'],
        f'{metrics["auc"]:.3f}' if not math.isnan(metrics['auc']) else 'N/A',
    )

    if not dry_run:
        version = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        model_path = _save_model(model, feature_names, metrics, n, version)
        _record_version(model_path, feature_names, metrics, n, version)

    return metrics


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')

    if not ENABLED:
        logger.info(
            '[meta-model-train] LUNA_META_MODEL_ENABLED=false → 학습 미실행 (SHADOW 원칙). '
            '활성화: LUNA_META_MODEL_ENABLED=true 설정 후 재실행.'
        )
        sys.exit(0)

    dataset_mod = _load_dataset_module()
    X, y, feature_names, entry_times = dataset_mod.build_dataset()

    if X.size == 0:
        logger.warning('[meta-model-train] 데이터셋 비어 있음 — 학습 skip')
        sys.exit(0)

    result = train_and_save(X, y, feature_names, entry_times)
    if result is None:
        sys.exit(0)

    auc_str = f'{result["auc"]:.3f}' if not math.isnan(result['auc']) else 'N/A'
    print(
        f'[meta-model-train] 완료 | '
        f'precision={result["precision"]:.3f} '
        f'recall={result["recall"]:.3f} '
        f'f1={result["f1"]:.3f} '
        f'auc={auc_str}'
    )


if __name__ == '__main__':
    main()
