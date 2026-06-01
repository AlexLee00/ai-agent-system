#!/usr/bin/env python3
"""
루나 Secondary Model — 학습 데이터셋 구성 모듈

소스: investment.trade_journal + investment.position_signal_history (LEFT JOIN on signal_id)
필터: exclude_from_learning=false AND exit_reason='normal_exit' AND pnl_net IS NOT NULL
라벨: pnl_net > 0 → 1 (win), else → 0 (loss)
피처: 진입 시점 데이터만 (누수 금지 — 진입 후 정보 미포함)

의존: numpy, pandas, psycopg2-binary
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
from typing import List, Tuple

import numpy as np
import pandas as pd

try:
    import psycopg2  # type: ignore
    import psycopg2.extras  # type: ignore
except ModuleNotFoundError:
    psycopg2 = None  # type: ignore

logger = logging.getLogger(__name__)

PG_DSN = os.environ.get("PG_DSN", "dbname=jay")
PSQL_DB = os.environ.get("PGDATABASE", "jay")

_FETCH_QUERY = """
SELECT
    j.id,
    j.entry_time,
    j.market,
    j.direction,
    j.strategy_family,
    j.market_regime,
    j.market_regime_confidence,
    j.atr_at_entry,
    j.pnl_net,
    COALESCE(sh.confidence,      0.0) AS signal_confidence,
    COALESCE(sh.sentiment_score, 0.0) AS signal_sentiment_score
FROM investment.trade_journal j
LEFT JOIN investment.position_signal_history sh
       ON sh.id = j.signal_id
WHERE COALESCE(j.exclude_from_learning, false) = false
  AND j.exit_reason = 'normal_exit'
  AND j.pnl_net IS NOT NULL
ORDER BY j.entry_time ASC
"""

# 원-핫 기준 값 고정 — 데이터에 없는 레짐도 피처 차원 일관 유지
_KNOWN_REGIMES = ['ranging', 'trending', 'unknown', 'volatile']
_KNOWN_DIRECTIONS = ['long', 'short']


def _psql_args() -> List[str]:
    """psycopg2가 없는 DEV 환경에서도 psql CLI로 동일 쿼리를 수행한다."""
    explicit_dsn = os.environ.get("PG_DSN")
    if explicit_dsn:
        return ["psql", explicit_dsn]
    return ["psql", "-d", PSQL_DB]


def _fetch_dataframe_with_psql() -> pd.DataFrame:
    query = _FETCH_QUERY.strip().rstrip(";")
    copy_sql = f"COPY ({query}) TO STDOUT WITH CSV HEADER"
    proc = subprocess.run(
        _psql_args() + ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", copy_sql],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "[meta-model-dataset] psql 조회 실패: "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    if not proc.stdout.strip():
        return pd.DataFrame()
    return pd.read_csv(io.StringIO(proc.stdout))


def _feature_matrix(df: pd.DataFrame) -> Tuple[np.ndarray, List[str]]:
    """DataFrame → (X ndarray, feature_names). 진입 시점 피처만 사용."""
    parts: List[np.ndarray] = []
    names: List[str] = []

    # 1. market_regime 원-핫 (고정 기준 — 미등장 시 all-zero)
    for regime in _KNOWN_REGIMES:
        parts.append((df['market_regime'] == regime).astype(float).values.reshape(-1, 1))
        names.append(f'regime_{regime}')

    # 2. market_regime_confidence (결측 → 0)
    parts.append(df['market_regime_confidence'].fillna(0.0).values.reshape(-1, 1))
    names.append('market_regime_confidence')

    # 3. atr_at_entry (결측 → 열 평균)
    atr = df['atr_at_entry'].copy()
    n_missing = int(atr.isna().sum())
    atr_mean = float(atr.mean()) if atr.notna().any() else 0.0
    if n_missing > 0:
        logger.info('[meta-model-dataset] atr_at_entry 결측 %d건 → 평균(%.6f) 대체', n_missing, atr_mean)
    parts.append(atr.fillna(atr_mean).values.reshape(-1, 1))
    names.append('atr_at_entry')

    # 4. direction 원-핫 (고정 기준)
    for direction in _KNOWN_DIRECTIONS:
        parts.append((df['direction'] == direction).astype(float).values.reshape(-1, 1))
        names.append(f'direction_{direction}')

    # 5. strategy_family 원-핫 (데이터에 등장한 값)
    families = sorted(df['strategy_family'].dropna().unique().tolist())
    for sf in families:
        parts.append((df['strategy_family'] == sf).astype(float).values.reshape(-1, 1))
        names.append(f'strategy_{sf}')

    # 6. market 원-핫 (데이터에 등장한 값)
    markets = sorted(df['market'].dropna().unique().tolist())
    for mkt in markets:
        parts.append((df['market'] == mkt).astype(float).values.reshape(-1, 1))
        names.append(f'market_{mkt}')

    # 7. signal_confidence / signal_sentiment_score (LEFT JOIN → 결측 이미 0)
    parts.append(df['signal_confidence'].fillna(0.0).values.reshape(-1, 1))
    names.append('signal_confidence')

    parts.append(df['signal_sentiment_score'].fillna(0.0).values.reshape(-1, 1))
    names.append('signal_sentiment_score')

    return np.hstack(parts), names


def build_dataset() -> Tuple[np.ndarray, np.ndarray, List[str], List]:
    """
    DB에서 학습 데이터셋을 구성한다.

    Returns: (X, y, feature_names, entry_times)
      - 행 순서는 entry_time ASC (시계열 split을 위한 보장)
    """
    if psycopg2 is not None:
        conn = psycopg2.connect(PG_DSN)
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(_FETCH_QUERY)
                rows = cur.fetchall()
        finally:
            conn.close()
        df = pd.DataFrame([dict(r) for r in rows])
    else:
        logger.info('[meta-model-dataset] psycopg2 없음 → psql CLI fallback 사용')
        df = _fetch_dataframe_with_psql()

    if df.empty:
        logger.warning('[meta-model-dataset] 조회 결과 없음 — 필터 조건 확인 요망')
        return np.empty((0, 0)), np.empty(0), [], []

    logger.info('[meta-model-dataset] %d건 로드 (entry_time ASC 정렬 확인)', len(df))

    y = (df['pnl_net'] > 0).astype(int).values
    X, feature_names = _feature_matrix(df)
    entry_times = df['entry_time'].tolist()

    logger.info(
        '[meta-model-dataset] X shape=%s, pos_rate=%.3f (win=%d loss=%d)',
        X.shape, float(y.mean()), int(y.sum()), int((y == 0).sum()),
    )
    return X, y, feature_names, entry_times


def build_dataset_from_df(df: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray, List[str], List]:
    """
    외부 주입 DataFrame에서 데이터셋을 구성한다 (dry test / 합성 데이터용).
    DB 접근 없음. df는 entry_time 오름차순 권장 (함수 내부에서 정렬).

    필수 컬럼:
      entry_time, market, direction, strategy_family, market_regime,
      market_regime_confidence, atr_at_entry, pnl_net,
      signal_confidence, signal_sentiment_score
    """
    if df.empty:
        return np.empty((0, 0)), np.empty(0), [], []

    df = df.sort_values('entry_time').reset_index(drop=True)
    y = (df['pnl_net'] > 0).astype(int).values
    X, feature_names = _feature_matrix(df)
    entry_times = df['entry_time'].tolist()
    return X, y, feature_names, entry_times


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    X, y, names, _ = build_dataset()
    if X.size == 0:
        print('[meta-model-dataset] 데이터 없음')
    else:
        print(f'[meta-model-dataset] 총 {len(y)}건 | win={int(y.sum())} loss={int((y == 0).sum())} '
              f'| 피처={len(names)}개')
        print(f'피처 목록: {names}')
