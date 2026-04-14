"""
ska-006/007/010/011/013/014: 포캐스트(FORECAST) — Prophet + SARIMA + SMA/EMA 앙상블 예측 엔진

ska-014 추가 (Level 4):
  - SARIMA 앙상블 (statsmodels SARIMAX, 단기 가중)
  - SMA/EMA 빠른 예측 (14일 미만 데이터 또는 보조)
  - 예약 건수 선행 지표 (reservation 스키마 연동)
  - 자동 파라미터 튜닝 (--mode=review, MAPE > 15%)
  - forecast_results 테이블 저장 (n8n SKA-WF-03 / 레베카 연동)
  - 🔮 앙상블 예측 알림 형식 (모델별 상세 출력)

모드:
  --mode=daily   : 익일 1일 예측 (기본)
  --mode=weekly  : 다음 7일 예측 (D+1 ~ D+7)
  --mode=monthly : 다음 30일 예측 (D+1 ~ D+30)
  --mode=review  : 월간 모델 진단 + LLM 분석 + 자동 파라미터 튜닝
  --date=YYYY-MM-DD : 기준 날짜 (기본: 오늘)
  --json         : JSON 출력 (텔레그램용)

모델 (prophet-v3 + ensemble):
  - Prophet (weekly_seasonality=True, yearly=False)
  - add_country_holidays(KR)
  - regressor: exam_score, rain_prob, vacation_flag, temperature (ska-010)
  - SARIMA(1,1,1)(1,1,1,7) — 단기 보정 (statsmodels, 선택적)
  - SMA/EMA — 빠른 예측 / 보조

실행: bots/ska/venv/bin/python bots/ska/src/forecast.py [--mode=daily]
launchd: 매일 18:00 (ai.ska.forecast)
"""
import sys
import os
import json
import math
import subprocess
import logging
import warnings
import psycopg2
import pandas as pd
from datetime import date as date_type, timedelta
from runtime_config import get_forecast_config

# RAG 클라이언트 (실패해도 예측 기능에 영향 없음)
try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))
    from bots.ska.lib.rag_client import RagClient as _RagClient
    from bots.ska.lib.feature_store import ensure_training_feature_table, sync_training_feature_store
    _rag = _RagClient()
except Exception:
    _rag = None
    ensure_training_feature_table = None
    sync_training_feature_store = None

warnings.filterwarnings('ignore')  # Prophet Stan 경고 억제
logging.getLogger('prophet.plot').setLevel(logging.CRITICAL)

PG_SKA = "dbname=jay options='-c search_path=ska,public'"

MODEL_VERSION  = 'prophet-v3'
TEMP_DEFAULT   = 15.0   # 기온 기본값 (°C) — 수집 누락 시
MIN_TRAIN_DAYS = 14     # 최소 학습 데이터 일수
WEEKDAY_KO     = ['월', '화', '수', '목', '금', '토', '일']
BIZ_START_H    = 9
BIZ_END_H      = 22
NUM_ROOMS      = 3
MAX_HOURS      = (BIZ_END_H - BIZ_START_H) * NUM_ROOMS
FORECAST_RUNTIME = get_forecast_config()
CALIBRATION_LOOKBACK_DAYS = 56
CALIBRATION_MAX_RATIO = FORECAST_RUNTIME.get('calibrationMaxRatio', 0.12)
RESERVATION_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME['reservationAdjustmentWeight']
CONDITION_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME['conditionAdjustmentWeight']
CONDITION_MIN_SAMPLES = 3
BOOKED_HOURS_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('bookedHoursAdjustmentWeight', 0.30)
ROOM_SPREAD_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('roomSpreadAdjustmentWeight', 0.20)
PEAK_OVERLAP_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('peakOverlapAdjustmentWeight', 0.18)
EVENING_PATTERN_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('eveningPatternAdjustmentWeight', 0.14)
MORNING_PATTERN_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('morningPatternAdjustmentWeight', 0.08)
AFTERNOON_PATTERN_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('afternoonPatternAdjustmentWeight', 0.10)
RESERVATION_TREND_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('reservationTrendAdjustmentWeight', 0.18)
BOOKED_HOURS_TREND_ADJUSTMENT_WEIGHT = FORECAST_RUNTIME.get('bookedHoursTrendAdjustmentWeight', 0.16)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
GEMMA_PILOT_CLI = os.path.join(PROJECT_ROOT, 'packages', 'core', 'scripts', 'gemma-pilot-cli.js')

# 자동 튜닝 파라미터 저장 경로 (review 모드에서 갱신)
_MODEL_PARAMS_FILE = os.path.join(os.path.dirname(__file__), '..', 'db', 'model_params.json')

# SARIMA 조건부 임포트
try:
    from statsmodels.tsa.statespace.sarimax import SARIMAX
    _SARIMA_AVAILABLE = True
except ImportError:
    _SARIMA_AVAILABLE = False
    print('[FORECAST] ⚠️ statsmodels 미설치 — SARIMA 비활성화 (pip install statsmodels)')


# ─── psycopg2 헬퍼 ──────────────────────────────────────────────────────────────

def _qry(con, sql, params=()):
    """SELECT → rows list"""
    cur = con.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def _one(con, sql, params=()):
    """SELECT single row"""
    cur = con.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    cur.close()
    return row


def sanitize_insight_line(raw_text):
    """메타/추론 출력은 버리고, 한국어 한 줄 인사이트만 남긴다."""
    if not raw_text:
        return ''

    blocked_prefixes = (
        '<|channel>',
        'Thinking Process',
        'Thinking process',
        'Analyze',
        'Calculation',
        '1.',
        '2.',
        '3.',
        '4.',
        '5.',
        '*',
        '-',
    )

    candidates = []
    for line in str(raw_text).splitlines():
        text = line.strip()
        if not text:
            continue
        if text.startswith(blocked_prefixes):
            continue
        lowered = text.lower()
        if 'today' in lowered or '7-day average' in lowered or 'outlier' in lowered:
            continue
        if any('가' <= ch <= '힣' for ch in text):
            candidates.append(text)

    if not candidates:
        return ''

    best = candidates[-1]
    if len(best) > 120:
        return ''
    return best


def build_daily_fallback_insight(result_row, recent_mape=None):
    """LLM 보조 인사이트가 비어도 붙일 수 있는 예측 한 줄 요약."""
    yhat = int(result_row.get('yhat') or 0)
    confidence = float(result_row.get('confidence') or _calc_confidence(result_row))
    reservation_count = int(result_row.get('reservation_count') or 0)

    if recent_mape is not None:
        try:
            mape = float(recent_mape)
            if mape <= 10:
                return f'예측 정확도는 최근 MAPE {mape:.1f}%로 안정적이며 내일 예상 매출은 {yhat:,}원입니다.'
            if mape >= 20:
                return f'최근 MAPE {mape:.1f}%로 변동성이 있어 내일 예상 매출 {yhat:,}원은 보수적으로 확인이 필요합니다.'
        except Exception:
            pass

    if reservation_count >= 5:
        return f'예약 흐름이 확보되어 내일 예상 매출은 {yhat:,}원 수준으로 보입니다.'
    if confidence >= 0.75:
        return f'모델 확신도가 높아 내일 예상 매출은 {yhat:,}원 수준으로 예상됩니다.'
    return f'내일 예상 매출은 {yhat:,}원이며 예약과 환경 변수에 따라 변동 가능성이 있습니다.'


def build_period_fallback_insight(label, total, avg_value, results):
    """주간/월간 예측에 붙일 결정론적 한 줄 요약."""
    if not results:
        return ''

    first = results[0]
    last = results[-1]
    delta = int((last.get('yhat') or 0) - (first.get('yhat') or 0))
    if abs(delta) >= max(20000, avg_value * 0.12):
        direction = '상승' if delta > 0 else '하락'
        return f'{label} 예상 매출은 총 {total:,}원이며 후반으로 갈수록 {direction} 흐름이 예상됩니다.'

    peak = max(int(r.get('yhat') or 0) for r in results)
    trough = min(int(r.get('yhat') or 0) for r in results)
    if peak - trough >= max(30000, avg_value * 0.15):
        return f'{label} 예상 매출은 총 {total:,}원이며 일별 변동폭이 큰 편입니다.'

    return f'{label} 예상 매출은 총 {total:,}원, 일 평균 {avg_value:,}원 수준으로 비교적 안정적입니다.'


# ─── 모델 파라미터 관리 ────────────────────────────────────────────────────────

def _load_model_params():
    """저장된 자동 튜닝 파라미터 로드 (없으면 기본값)"""
    try:
        with open(_MODEL_PARAMS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def _save_model_params(params):
    """자동 튜닝 파라미터 저장"""
    os.makedirs(os.path.dirname(_MODEL_PARAMS_FILE), exist_ok=True)
    with open(_MODEL_PARAMS_FILE, 'w') as f:
        json.dump(params, f, indent=2)
    print(f'[FORECAST] 모델 파라미터 저장 → {_MODEL_PARAMS_FILE}')


# ─── 인자 파싱 ─────────────────────────────────────────────────────────────────

def parse_args():
    mode = 'daily'
    base_date = None
    output_json = False
    for arg in sys.argv[1:]:
        if arg.startswith('--mode='):
            mode = arg.split('=', 1)[1]
        elif arg.startswith('--date='):
            base_date = arg.split('=', 1)[1]
        elif arg == '--json':
            output_json = True
    return mode, base_date, output_json


# ─── 데이터 로드 ──────────────────────────────────────────────────────────────

def load_history(con):
    """revenue_daily + environment_factors + exam_events JOIN → Prophet 학습용 DataFrame
    ska-007: exam_score = env.exam_score + SUM(exam_events.score_weight)
    """
    rows = _qry(con, """
        SELECT
            r.date,
            r.actual_revenue,
            COALESCE(e.exam_score,   0) +
                COALESCE(ex.total_event_score, 0)              AS exam_score,
            COALESCE(e.rain_prob,    0.0)                      AS rain_prob,
            COALESCE(CAST(e.vacation_flag AS INTEGER), 0)      AS vacation_flag,
            COALESCE(e.temperature, 15.0)                      AS temperature,
            COALESCE(CAST(e.bridge_holiday_flag AS INTEGER), 0) AS bridge_holiday
        FROM revenue_daily r
        LEFT JOIN environment_factors e ON e.date = r.date
        LEFT JOIN (
            SELECT date, SUM(score_weight) AS total_event_score
            FROM exam_events
            GROUP BY date
        ) ex ON ex.date = r.date
        ORDER BY r.date
    """)

    df = pd.DataFrame(rows, columns=['ds', 'y', 'exam_score', 'rain_prob', 'vacation_flag', 'temperature', 'bridge_holiday'])
    df['ds'] = pd.to_datetime(df['ds'])
    df['y'] = df['y'].astype(float)
    return df


def load_weekday_avg(con):
    """요일별 평균 매출 → base_forecast 기준값
    EXTRACT(DOW FROM date): 0=일..6=토
    """
    rows = _qry(con, """
        SELECT EXTRACT(DOW FROM date)::integer AS dow, AVG(actual_revenue) AS avg_rev
        FROM revenue_daily
        GROUP BY 1 ORDER BY 1
    """)
    return {r[0]: round(r[1]) for r in rows}


def load_future_env(con, start_date, end_date):
    """예측 기간의 환경 요인 로드
    ska-007: environment_factors + exam_events UNION — 한쪽만 있는 날도 커버
    """
    rows = _qry(con, """
        SELECT
            d.date,
            COALESCE(e.exam_score, 0) +
                COALESCE(ex.total_event_score, 0)              AS exam_score,
            COALESCE(e.rain_prob,    0.0)                      AS rain_prob,
            COALESCE(CAST(e.vacation_flag AS INTEGER), 0)      AS vacation_flag,
            COALESCE(e.temperature, 15.0)                      AS temperature,
            COALESCE(CAST(e.bridge_holiday_flag AS INTEGER), 0) AS bridge_holiday
        FROM (
            SELECT date FROM environment_factors
            WHERE date >= %s AND date <= %s
            UNION
            SELECT date FROM exam_events
            WHERE date >= %s AND date <= %s
        ) d
        LEFT JOIN environment_factors e ON e.date = d.date
        LEFT JOIN (
            SELECT date, SUM(score_weight) AS total_event_score
            FROM exam_events
            GROUP BY date
        ) ex ON ex.date = d.date
        ORDER BY d.date
    """, (str(start_date), str(end_date),
          str(start_date), str(end_date)))

    env = {str(r[0]): {'exam_score': r[1], 'rain_prob': r[2], 'vacation_flag': r[3], 'temperature': r[4], 'bridge_holiday': r[5]}
           for r in rows}
    return env


# ─── Prophet 모델 ─────────────────────────────────────────────────────────────

def build_model(params=None):
    """Prophet 모델 생성 (자동 튜닝 파라미터 적용 가능)"""
    from prophet import Prophet
    p = params if params is not None else _load_model_params()
    model = Prophet(
        weekly_seasonality=True,
        yearly_seasonality=False,
        daily_seasonality=False,
        seasonality_mode='additive',
        interval_width=0.80,
        uncertainty_samples=500,
        changepoint_prior_scale=p.get('changepoint_prior_scale', 0.05),
        seasonality_prior_scale=p.get('seasonality_prior_scale', 10.0),
    )
    model.add_country_holidays(country_name='KR')
    model.add_regressor('exam_score')
    model.add_regressor('rain_prob')
    model.add_regressor('vacation_flag')
    model.add_regressor('temperature')    # ska-010: 기온 영향
    model.add_regressor('bridge_holiday') # ska-012: 징검다리 연휴
    return model


def fill_future_regressors(future_df, env_map):
    """미래 DataFrame에 환경 요인 채우기 (없는 날 = 0)"""
    future_df = future_df.copy()
    dates = future_df['ds'].dt.strftime('%Y-%m-%d')
    future_df['exam_score']    = dates.map(lambda d: env_map.get(d, {}).get('exam_score',    0))
    future_df['rain_prob']     = dates.map(lambda d: env_map.get(d, {}).get('rain_prob',     0.0))
    future_df['vacation_flag'] = dates.map(lambda d: env_map.get(d, {}).get('vacation_flag', 0))
    future_df['temperature']   = dates.map(lambda d: env_map.get(d, {}).get('temperature',   TEMP_DEFAULT))
    future_df['bridge_holiday']= dates.map(lambda d: env_map.get(d, {}).get('bridge_holiday', 0))
    return future_df


# ─── SARIMA 앙상블 (ska-014) ──────────────────────────────────────────────────

def forecast_sarima(df, periods=None):
    """SARIMA(1,1,1)(1,1,1,7) 단기 예측 — 주간 계절성 반영
    statsmodels 미설치 시 None 반환 (Prophet 폴백)
    """
    periods = periods or FORECAST_RUNTIME['sarimaPeriods']
    if not _SARIMA_AVAILABLE:
        return None
    try:
        model = SARIMAX(
            df['y'],
            order=(1, 1, 1),
            seasonal_order=(1, 1, 1, 7),
            enforce_stationarity=False,
            enforce_invertibility=False,
        )
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            result = model.fit(disp=False, maxiter=FORECAST_RUNTIME['sarimaMaxIter'])
        forecast = result.forecast(steps=periods)
        return [max(0.0, float(v)) for v in forecast.values]
    except Exception as e:
        print(f'[FORECAST] SARIMA 실패: {e}')
        return None


def quick_forecast_sma(df, target_date):
    """SMA/EMA 기반 빠른 예측
    요일 평균 50% + EMA7 30% + SMA7 20%
    14일 미만 데이터 또는 SARIMA 없을 때 보조로 활용
    """
    dow = target_date.weekday()  # 0=월..6=일

    # 같은 요일 최근 4주 평균
    same_dow = df[df['ds'].dt.weekday == dow].tail(4)
    dow_avg = float(same_dow['y'].mean()) if len(same_dow) > 0 else 0.0

    tail7 = df.tail(7)
    sma_7 = float(tail7['y'].mean()) if len(tail7) > 0 else 0.0
    ema_7 = float(tail7['y'].ewm(span=7).mean().iloc[-1]) if len(tail7) > 0 else 0.0

    quick_pred = dow_avg * 0.5 + ema_7 * 0.3 + sma_7 * 0.2

    return {
        'prediction': round(quick_pred),
        'dow_avg':    round(dow_avg),
        'sma_7':      round(sma_7),
        'ema_7':      round(ema_7),
        'method':     'quick_sma_ema',
    }


def get_per_model_accuracy(con, days=None):
    """최근 N일 모델별 MAPE 조회 (forecast_results × revenue_daily JOIN)
    반환: {'prophet': 8.5, 'sarima': 12.3, 'quick': 15.0}  — 데이터 없으면 {}
    """
    try:
        row = _one(con, """
            SELECT
                AVG(ABS((fr.predictions->>'yhat_prophet')::float - rd.actual_revenue)
                    / NULLIF(rd.actual_revenue, 0)) * 100 AS prophet_mape,
                AVG(ABS((fr.predictions->>'yhat_sarima')::float - rd.actual_revenue)
                    / NULLIF(rd.actual_revenue, 0)) * 100 AS sarima_mape,
                AVG(ABS((fr.predictions->>'yhat_quick')::float - rd.actual_revenue)
                    / NULLIF(rd.actual_revenue, 0)) * 100 AS quick_mape
            FROM forecast_results fr
            JOIN revenue_daily rd ON rd.date = fr.forecast_date
            WHERE fr.forecast_date >= current_date - %s
              AND rd.actual_revenue > 0
              AND fr.predictions->>'yhat_prophet' IS NOT NULL
        """, (days,))
        if not row or all(v is None for v in row):
            return {}
        return {
            k: round(float(v), 2)
            for k, v in zip(['prophet', 'sarima', 'quick'], row)
            if v is not None
        }
    except Exception:
        return {}


def calculate_dynamic_weights(accuracy):
    """모델별 MAPE 역수 기반 동적 가중치 계산
    MAPE가 낮을수록 정확한 모델 → 더 높은 가중치 부여
    최소 가중치 10% 보장 후 재정규화
    반환: {'prophet': 0.45, 'sarima': 0.30, 'quick': 0.25} or None
    """
    if not accuracy or len(accuracy) < 2:
        return None

    MIN_WEIGHT = FORECAST_RUNTIME['minimumModelWeight']
    inv = {}
    for model, mape in accuracy.items():
        inv[model] = 1.0 / mape if (mape and mape > 0) else 0.1  # 기본 10% MAPE 가정

    total = sum(inv.values())
    if total == 0:
        return None

    weights = {m: v / total for m, v in inv.items()}

    # 최소 가중치 보장 후 재정규화
    for m in weights:
        if weights[m] < MIN_WEIGHT:
            weights[m] = MIN_WEIGHT
    total2 = sum(weights.values())
    return {m: round(w / total2, 4) for m, w in weights.items()}


def _ensemble_val(prophet_val, sarima_val, quick_val, day_idx, weights=None):
    """Prophet + SARIMA + SMA/EMA 앙상블
    단기(0~2일): SARIMA 가중  / 장기(3일+): Prophet 가중
    SARIMA 없으면: Prophet 70% + quick 30%
    weights: 동적 가중치 dict (없으면 기본값 사용)
    """
    if sarima_val is None:
        if weights:
            t = weights.get('prophet', 0.7) + weights.get('quick', 0.3)
            if t > 0:
                p_w = weights.get('prophet', 0.7) / t
                q_w = weights.get('quick',   0.3) / t
                return round(prophet_val * p_w + quick_val * q_w)
        return round(prophet_val * 0.7 + quick_val * 0.3)

    if weights:
        p_w = weights.get('prophet', 0.30 if day_idx < 3 else 0.55)
        s_w = weights.get('sarima',  0.50 if day_idx < 3 else 0.25)
        q_w = weights.get('quick',   0.20)
        t = p_w + s_w + q_w
        if t > 0:
            return round(prophet_val * p_w/t + sarima_val * s_w/t + quick_val * q_w/t)

    if day_idx < 3:  # 단기
        p_w, s_w, q_w = 0.30, 0.50, 0.20
    else:            # 장기
        p_w, s_w, q_w = 0.55, 0.25, 0.20
    return round(prophet_val * p_w + sarima_val * s_w + quick_val * q_w)


# ─── 예약 선행 지표 (ska-014) ─────────────────────────────────────────────────

def _calc_booked_hours(rows):
    total_minutes = 0
    for start_time, end_time, _room in rows:
        try:
            sh, sm = str(start_time).split(':')
            eh, em = str(end_time).split(':')
            start_minutes = int(sh) * 60 + int(sm)
            end_minutes = int(eh) * 60 + int(em)
            if end_minutes > start_minutes:
                total_minutes += end_minutes - start_minutes
        except Exception:
            continue
    return round(total_minutes / 60.0, 2)


def _to_minutes(time_text):
    try:
        h, m = str(time_text).split(':')
        return int(h) * 60 + int(m)
    except Exception:
        return None


def _calc_peak_overlap(rows):
    events = []
    for start_time, end_time, _room in rows:
        start_minutes = _to_minutes(start_time)
        end_minutes = _to_minutes(end_time)
        if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
            continue
        events.append((start_minutes, 1))
        events.append((end_minutes, -1))

    current = 0
    peak = 0
    for _minute, delta in sorted(events, key=lambda item: (item[0], item[1])):
        current += delta
        peak = max(peak, current)
    return peak


def _calc_avg_duration_hours(rows):
    durations = []
    for start_time, end_time, _room in rows:
        start_minutes = _to_minutes(start_time)
        end_minutes = _to_minutes(end_time)
        if start_minutes is None or end_minutes is None or end_minutes <= start_minutes:
            continue
        durations.append((end_minutes - start_minutes) / 60.0)
    if not durations:
        return 0.0
    return round(sum(durations) / len(durations), 2)


def get_reservation_signal(con, target_date_str):
    """예측일 예약 건수 + 예약 시간 + 밀도 조회"""
    try:
        # Same DB, different schema: reuse the active connection so forecast does not
        # silently diverge from the runtime DB state.
        rows = _qry(con, """
            SELECT start_time, end_time, room
            FROM reservation.reservations
            WHERE date = %s
              AND status IN ('confirmed', 'pending', 'completed')
        """, (target_date_str,))
        count = len(rows)
        booked_hours = _calc_booked_hours(rows)
        unique_rooms = len({str(row[2]).strip() for row in rows if row[2]})
        peak_overlap = _calc_peak_overlap(rows)
        avg_duration_hours = _calc_avg_duration_hours(rows)
        room_counts = {'A1': 0, 'A2': 0, 'B': 0}
        morning_count = 0
        afternoon_count = 0
        evening_count = 0
        for start_time, _end_time, room in rows:
            room_key = str(room or '').strip().upper()
            if room_key in room_counts:
                room_counts[room_key] += 1
            start_minutes = _to_minutes(start_time)
            if start_minutes is None:
                continue
            if start_minutes < 13 * 60:
                morning_count += 1
            elif start_minutes < 18 * 60:
                afternoon_count += 1
            else:
                evening_count += 1
        return {
            'count': count,
            'booked_hours': booked_hours,
            'density': round(booked_hours / MAX_HOURS, 4) if MAX_HOURS > 0 else 0.0,
            'unique_rooms': unique_rooms,
            'peak_overlap': peak_overlap,
            'avg_duration_hours': avg_duration_hours,
            'room_counts': room_counts,
            'morning_count': morning_count,
            'afternoon_count': afternoon_count,
            'evening_count': evening_count,
        }
    except Exception as e:
        print(f'[FORECAST] ⚠️ 예약 신호 조회 실패 ({target_date_str}): {e}')
        return {
            'count': 0,
            'booked_hours': 0.0,
            'density': 0.0,
            'unique_rooms': 0,
            'peak_overlap': 0,
            'avg_duration_hours': 0.0,
            'room_counts': {'A1': 0, 'A2': 0, 'B': 0},
            'morning_count': 0,
            'afternoon_count': 0,
            'evening_count': 0,
        }


def _load_recent_calibration_stats(con, days=CALIBRATION_LOOKBACK_DAYS):
    """training_feature_daily 기반 최근 오차/예약/조건 보정값 산출"""
    rows = _qry(con, """
        SELECT
            date,
            weekday,
            target_revenue,
            predicted_revenue,
            COALESCE(reservation_count, total_reservations, 0) AS reservation_count,
            COALESCE(total_reservations, 0) AS total_reservations,
            COALESCE(reservation_booked_hours, 0.0) AS reservation_booked_hours,
            COALESCE(reservation_unique_rooms, 0) AS reservation_unique_rooms,
            COALESCE(reservation_peak_overlap, 0) AS reservation_peak_overlap,
            COALESCE(reservation_morning_count, 0) AS reservation_morning_count,
            COALESCE(reservation_afternoon_count, 0) AS reservation_afternoon_count,
            COALESCE(reservation_evening_count, 0) AS reservation_evening_count,
            COALESCE(lag_reservation_count_1d, 0) AS lag_reservation_count_1d,
            COALESCE(lag_reservation_count_3d, 0) AS lag_reservation_count_3d,
            COALESCE(lag_reservation_hours_1d, 0.0) AS lag_reservation_hours_1d,
            COALESCE(lag_reservation_hours_3d, 0.0) AS lag_reservation_hours_3d,
            COALESCE(holiday_flag, false) AS holiday_flag,
            COALESCE(vacation_flag, false) AS vacation_flag,
            COALESCE(festival_flag, false) AS festival_flag,
            COALESCE(bridge_holiday_flag, false) AS bridge_holiday_flag,
            COALESCE(rain_prob, 0.0) AS rain_prob,
            COALESCE(exam_score, 0) AS exam_score,
            COALESCE(forecast_error, target_revenue - predicted_revenue) AS forecast_error
        FROM training_feature_daily
        WHERE date >= current_date - %s
          AND date < current_date
          AND target_revenue IS NOT NULL
          AND predicted_revenue IS NOT NULL
          AND target_revenue > 0
    """, (days,))

    weekday_bias = {}
    reservation_baseline = {}
    revenue_per_reservation = 0.0
    booked_hours_baseline = {}
    revenue_per_booked_hour = 0.0
    unique_rooms_baseline = {}
    peak_overlap_baseline = {}
    morning_count_baseline = {}
    afternoon_count_baseline = {}
    evening_count_baseline = {}
    reservation_trend_baseline = {}
    booked_hours_trend_baseline = {}
    condition_bias = {}
    sample_count = len(rows)

    if not rows:
        return {
            'weekday_bias': weekday_bias,
            'reservation_baseline': reservation_baseline,
            'revenue_per_reservation': revenue_per_reservation,
            'booked_hours_baseline': booked_hours_baseline,
            'revenue_per_booked_hour': revenue_per_booked_hour,
            'unique_rooms_baseline': unique_rooms_baseline,
            'peak_overlap_baseline': peak_overlap_baseline,
            'evening_count_baseline': evening_count_baseline,
            'condition_bias': condition_bias,
            'sample_count': sample_count,
        }

    bias_buckets = {i: [] for i in range(1, 8)}
    reservation_buckets = {i: [] for i in range(1, 8)}
    booked_hours_buckets = {i: [] for i in range(1, 8)}
    unique_rooms_buckets = {i: [] for i in range(1, 8)}
    peak_overlap_buckets = {i: [] for i in range(1, 8)}
    morning_count_buckets = {i: [] for i in range(1, 8)}
    afternoon_count_buckets = {i: [] for i in range(1, 8)}
    evening_count_buckets = {i: [] for i in range(1, 8)}
    reservation_trend_buckets = {i: [] for i in range(1, 8)}
    booked_hours_trend_buckets = {i: [] for i in range(1, 8)}
    revenue_per_reservation_samples = []
    revenue_per_booked_hour_samples = []
    condition_buckets = {
        'holiday': [],
        'vacation': [],
        'festival': [],
        'bridge_holiday': [],
        'rainy_day': [],
        'exam_high': [],
    }
    global_bias_values = []

    for row in rows:
        dow = int(row[1] or 0)
        actual = float(row[2] or 0.0)
        predicted = float(row[3] or 0.0)
        reservation_count = int(row[4] or 0)
        total_reservations = int(row[5] or 0)
        booked_hours = float(row[6] or 0.0)
        unique_rooms = int(row[7] or 0)
        peak_overlap = int(row[8] or 0)
        morning_count = int(row[9] or 0)
        afternoon_count = int(row[10] or 0)
        evening_count = int(row[11] or 0)
        lag_reservation_count_1d = float(row[12] or 0.0)
        lag_reservation_count_3d = float(row[13] or 0.0)
        lag_reservation_hours_1d = float(row[14] or 0.0)
        lag_reservation_hours_3d = float(row[15] or 0.0)
        error = float(row[22] or 0.0)
        recent_count_anchor = sum(v for v in [lag_reservation_count_1d, lag_reservation_count_3d] if v > 0)
        recent_count_divisor = sum(1 for v in [lag_reservation_count_1d, lag_reservation_count_3d] if v > 0)
        recent_hours_anchor = sum(v for v in [lag_reservation_hours_1d, lag_reservation_hours_3d] if v > 0)
        recent_hours_divisor = sum(1 for v in [lag_reservation_hours_1d, lag_reservation_hours_3d] if v > 0)
        reservation_trend = reservation_count - (recent_count_anchor / recent_count_divisor) if recent_count_divisor else 0.0
        booked_hours_trend = booked_hours - (recent_hours_anchor / recent_hours_divisor) if recent_hours_divisor else 0.0

        bias_buckets[dow].append(error)
        reservation_buckets[dow].append(reservation_count if reservation_count > 0 else total_reservations)
        booked_hours_buckets[dow].append(booked_hours)
        unique_rooms_buckets[dow].append(unique_rooms)
        peak_overlap_buckets[dow].append(peak_overlap)
        morning_count_buckets[dow].append(morning_count)
        afternoon_count_buckets[dow].append(afternoon_count)
        evening_count_buckets[dow].append(evening_count)
        reservation_trend_buckets[dow].append(reservation_trend)
        booked_hours_trend_buckets[dow].append(booked_hours_trend)
        global_bias_values.append(error)
        if reservation_count > 0:
            revenue_per_reservation_samples.append(actual / reservation_count)
        elif total_reservations > 0:
            revenue_per_reservation_samples.append(actual / total_reservations)
        if booked_hours > 0:
            revenue_per_booked_hour_samples.append(actual / booked_hours)
        if row[16]:
            condition_buckets['holiday'].append(error)
        if row[17]:
            condition_buckets['vacation'].append(error)
        if row[18]:
            condition_buckets['festival'].append(error)
        if row[19]:
            condition_buckets['bridge_holiday'].append(error)
        if float(row[20] or 0.0) >= 0.4:
            condition_buckets['rainy_day'].append(error)
        if int(row[21] or 0) >= 5:
            condition_buckets['exam_high'].append(error)

    global_bias = round(sum(global_bias_values) / len(global_bias_values)) if global_bias_values else 0

    for dow, values in bias_buckets.items():
        if values:
            weekday_bias[dow] = round((sum(values) / len(values)) * 0.7 + global_bias * 0.3)
    for dow, values in reservation_buckets.items():
        if values:
            reservation_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in booked_hours_buckets.items():
        if values:
            booked_hours_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in unique_rooms_buckets.items():
        if values:
            unique_rooms_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in peak_overlap_buckets.items():
        if values:
            peak_overlap_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in morning_count_buckets.items():
        if values:
            morning_count_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in afternoon_count_buckets.items():
        if values:
            afternoon_count_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in evening_count_buckets.items():
        if values:
            evening_count_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in reservation_trend_buckets.items():
        if values:
            reservation_trend_baseline[dow] = round(sum(values) / len(values), 2)
    for dow, values in booked_hours_trend_buckets.items():
        if values:
            booked_hours_trend_baseline[dow] = round(sum(values) / len(values), 2)
    if revenue_per_reservation_samples:
        revenue_per_reservation = sum(revenue_per_reservation_samples) / len(revenue_per_reservation_samples)
    if revenue_per_booked_hour_samples:
        revenue_per_booked_hour = sum(revenue_per_booked_hour_samples) / len(revenue_per_booked_hour_samples)
    for key, values in condition_buckets.items():
        if len(values) >= CONDITION_MIN_SAMPLES:
            condition_bias[key] = round(sum(values) / len(values))

    return {
        'weekday_bias': weekday_bias,
        'reservation_baseline': reservation_baseline,
        'revenue_per_reservation': revenue_per_reservation,
        'booked_hours_baseline': booked_hours_baseline,
        'revenue_per_booked_hour': revenue_per_booked_hour,
        'unique_rooms_baseline': unique_rooms_baseline,
        'peak_overlap_baseline': peak_overlap_baseline,
        'morning_count_baseline': morning_count_baseline,
        'afternoon_count_baseline': afternoon_count_baseline,
        'evening_count_baseline': evening_count_baseline,
        'reservation_trend_baseline': reservation_trend_baseline,
        'booked_hours_trend_baseline': booked_hours_trend_baseline,
        'condition_bias': condition_bias,
        'sample_count': sample_count,
        'global_bias': global_bias,
    }


def _apply_result_calibration(result, calibration, target_date):
    """최근 요일 오차와 예약 선행 지표로 보수적 보정"""
    if not calibration:
        result['calibration_adjustment'] = 0
        result['calibration_notes'] = []
        return result

    # ISO weekday to match training_feature_daily.weekday (1=월 ... 7=일)
    dow = target_date.isoweekday()
    weekday_bias = int(calibration.get('weekday_bias', {}).get(dow, 0) or 0)
    reservation_baseline = float(calibration.get('reservation_baseline', {}).get(dow, 0.0) or 0.0)
    revenue_per_reservation = float(calibration.get('revenue_per_reservation', 0.0) or 0.0)
    booked_hours_baseline = float(calibration.get('booked_hours_baseline', {}).get(dow, 0.0) or 0.0)
    revenue_per_booked_hour = float(calibration.get('revenue_per_booked_hour', 0.0) or 0.0)
    unique_rooms_baseline = float(calibration.get('unique_rooms_baseline', {}).get(dow, 0.0) or 0.0)
    peak_overlap_baseline = float(calibration.get('peak_overlap_baseline', {}).get(dow, 0.0) or 0.0)
    morning_count_baseline = float(calibration.get('morning_count_baseline', {}).get(dow, 0.0) or 0.0)
    afternoon_count_baseline = float(calibration.get('afternoon_count_baseline', {}).get(dow, 0.0) or 0.0)
    evening_count_baseline = float(calibration.get('evening_count_baseline', {}).get(dow, 0.0) or 0.0)
    reservation_trend_baseline = float(calibration.get('reservation_trend_baseline', {}).get(dow, 0.0) or 0.0)
    booked_hours_trend_baseline = float(calibration.get('booked_hours_trend_baseline', {}).get(dow, 0.0) or 0.0)
    reservation_count = int(result.get('reservation_count', 0) or 0)
    reservation_booked_hours = float(result.get('reservation_booked_hours', 0.0) or 0.0)
    reservation_unique_rooms = int(result.get('reservation_unique_rooms', 0) or 0)
    reservation_peak_overlap = int(result.get('reservation_peak_overlap', 0) or 0)
    reservation_morning_count = int(result.get('reservation_morning_count', 0) or 0)
    reservation_afternoon_count = int(result.get('reservation_afternoon_count', 0) or 0)
    reservation_evening_count = int(result.get('reservation_evening_count', 0) or 0)
    env_info = result.get('env_info') or {}
    recent_count_anchor_values = [v for v in [reservation_baseline, reservation_trend_baseline + reservation_baseline] if v > 0]
    recent_hours_anchor_values = [v for v in [booked_hours_baseline, booked_hours_trend_baseline + booked_hours_baseline] if v > 0]
    live_reservation_trend = reservation_count - (sum(recent_count_anchor_values) / len(recent_count_anchor_values)) if recent_count_anchor_values else 0.0
    live_booked_hours_trend = reservation_booked_hours - (sum(recent_hours_anchor_values) / len(recent_hours_anchor_values)) if recent_hours_anchor_values else 0.0

    reservation_adjustment = 0
    if reservation_baseline > 0 and revenue_per_reservation > 0 and reservation_count > 0:
        reservation_delta = reservation_count - reservation_baseline
        reservation_adjustment = round(
            reservation_delta * revenue_per_reservation * RESERVATION_ADJUSTMENT_WEIGHT
        )

    booked_hours_adjustment = 0
    if booked_hours_baseline > 0 and revenue_per_booked_hour > 0 and reservation_booked_hours > 0:
        booked_hours_delta = reservation_booked_hours - booked_hours_baseline
        booked_hours_adjustment = round(
            booked_hours_delta * revenue_per_booked_hour * BOOKED_HOURS_ADJUSTMENT_WEIGHT
        )

    room_spread_adjustment = 0
    if unique_rooms_baseline > 0 and reservation_unique_rooms > 0 and revenue_per_reservation > 0:
        room_spread_delta = reservation_unique_rooms - unique_rooms_baseline
        room_spread_adjustment = round(
            room_spread_delta * revenue_per_reservation * ROOM_SPREAD_ADJUSTMENT_WEIGHT
        )

    peak_overlap_adjustment = 0
    if peak_overlap_baseline > 0 and reservation_peak_overlap > 0 and revenue_per_booked_hour > 0:
        overlap_delta = reservation_peak_overlap - peak_overlap_baseline
        peak_overlap_adjustment = round(
            overlap_delta * revenue_per_booked_hour * PEAK_OVERLAP_ADJUSTMENT_WEIGHT
        )

    morning_adjustment = 0
    if morning_count_baseline > 0 and reservation_morning_count > 0 and revenue_per_reservation > 0:
        morning_delta = reservation_morning_count - morning_count_baseline
        morning_adjustment = round(
            morning_delta * revenue_per_reservation * MORNING_PATTERN_ADJUSTMENT_WEIGHT
        )

    afternoon_adjustment = 0
    if afternoon_count_baseline > 0 and reservation_afternoon_count > 0 and revenue_per_reservation > 0:
        afternoon_delta = reservation_afternoon_count - afternoon_count_baseline
        afternoon_adjustment = round(
            afternoon_delta * revenue_per_reservation * AFTERNOON_PATTERN_ADJUSTMENT_WEIGHT
        )

    evening_adjustment = 0
    if evening_count_baseline > 0 and reservation_evening_count > 0 and revenue_per_reservation > 0:
        evening_delta = reservation_evening_count - evening_count_baseline
        evening_adjustment = round(
            evening_delta * revenue_per_reservation * EVENING_PATTERN_ADJUSTMENT_WEIGHT
        )

    reservation_trend_adjustment = 0
    if revenue_per_reservation > 0 and live_reservation_trend:
        reservation_trend_adjustment = round(
            live_reservation_trend * revenue_per_reservation * RESERVATION_TREND_ADJUSTMENT_WEIGHT
        )

    booked_hours_trend_adjustment = 0
    if revenue_per_booked_hour > 0 and live_booked_hours_trend:
        booked_hours_trend_adjustment = round(
            live_booked_hours_trend * revenue_per_booked_hour * BOOKED_HOURS_TREND_ADJUSTMENT_WEIGHT
        )

    condition_adjustment = 0
    condition_notes = []
    condition_bias = calibration.get('condition_bias', {})
    if env_info.get('bridge_holiday') and condition_bias.get('bridge_holiday'):
        condition_adjustment += round(condition_bias['bridge_holiday'] * CONDITION_ADJUSTMENT_WEIGHT)
        condition_notes.append(f"bridge:{condition_bias['bridge_holiday']:+,}")
    if env_info.get('vacation_flag') and condition_bias.get('vacation'):
        condition_adjustment += round(condition_bias['vacation'] * CONDITION_ADJUSTMENT_WEIGHT)
        condition_notes.append(f"vacation:{condition_bias['vacation']:+,}")
    if env_info.get('rain_prob', 0.0) >= 0.4 and condition_bias.get('rainy_day'):
        condition_adjustment += round(condition_bias['rainy_day'] * CONDITION_ADJUSTMENT_WEIGHT)
        condition_notes.append(f"rain:{condition_bias['rainy_day']:+,}")
    if env_info.get('exam_score', 0) >= 5 and condition_bias.get('exam_high'):
        condition_adjustment += round(condition_bias['exam_high'] * CONDITION_ADJUSTMENT_WEIGHT)
        condition_notes.append(f"exam:{condition_bias['exam_high']:+,}")

    raw_adjustment = (
        weekday_bias
        + reservation_adjustment
        + booked_hours_adjustment
        + room_spread_adjustment
        + peak_overlap_adjustment
        + morning_adjustment
        + afternoon_adjustment
        + evening_adjustment
        + reservation_trend_adjustment
        + booked_hours_trend_adjustment
        + condition_adjustment
    )
    max_adjustment = round(max(0, result['yhat']) * CALIBRATION_MAX_RATIO)
    bounded_adjustment = max(-max_adjustment, min(max_adjustment, raw_adjustment))

    result['yhat'] = max(0, result['yhat'] + bounded_adjustment)
    adjusted_lower = max(0, result['yhat_lower'] + bounded_adjustment)
    adjusted_upper = max(adjusted_lower, result['yhat_upper'] + bounded_adjustment)
    result['yhat_lower'] = min(adjusted_lower, result['yhat'])
    result['yhat_upper'] = max(adjusted_upper, result['yhat'])
    result['calibration_adjustment'] = bounded_adjustment

    notes = []
    if weekday_bias:
        notes.append(f'weekday_bias:{weekday_bias:+,}')
    if reservation_adjustment:
        notes.append(f'reservation:{reservation_adjustment:+,}')
    if booked_hours_adjustment:
        notes.append(f'booked_hours:{booked_hours_adjustment:+,}')
    if room_spread_adjustment:
        notes.append(f'rooms:{room_spread_adjustment:+,}')
    if peak_overlap_adjustment:
        notes.append(f'peak:{peak_overlap_adjustment:+,}')
    if morning_adjustment:
        notes.append(f'morning:{morning_adjustment:+,}')
    if afternoon_adjustment:
        notes.append(f'afternoon:{afternoon_adjustment:+,}')
    if evening_adjustment:
        notes.append(f'evening:{evening_adjustment:+,}')
    if reservation_trend_adjustment:
        notes.append(f'res_trend:{reservation_trend_adjustment:+,}')
    if booked_hours_trend_adjustment:
        notes.append(f'hour_trend:{booked_hours_trend_adjustment:+,}')
    notes.extend(condition_notes)
    if raw_adjustment != bounded_adjustment:
        notes.append(f'capped:{bounded_adjustment:+,}')
    if calibration.get('sample_count'):
        notes.append(f"samples:{calibration['sample_count']}")
    result['calibration_notes'] = notes
    return result


# ─── forecast_results 테이블 (n8n 연동) ──────────────────────────────────────

def ensure_forecast_results_table(con):
    """ska.forecast_results 테이블이 없으면 생성"""
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ska.forecast_results (
            id              SERIAL PRIMARY KEY,
            forecast_date   DATE NOT NULL,
            model_version   TEXT NOT NULL DEFAULT 'prophet-v3',
            predictions     JSONB NOT NULL,
            mape            REAL,
            params          JSONB DEFAULT '{}',
            created_at      TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (forecast_date, model_version)
        )
    """)
    con.commit()
    cur.close()


def save_forecast_result(con, forecast_date, result, mape=None, forecast_mode='daily'):
    """예측 결과를 ska.forecast_results에 저장 → n8n/레베카에서 조회 가능"""
    shadow_model = result.get('shadow_model') or {}
    shadow_blend = result.get('shadow_blend') or {}
    predictions = {
        'yhat':         result['yhat'],
        'yhat_prophet': result.get('yhat_prophet', result['yhat']),
        'yhat_sarima':  result.get('yhat_sarima'),
        'yhat_quick':   result.get('yhat_quick'),
        'base_forecast': result.get('base_forecast'),
        'env_score': result.get('env_score'),
        'env_info': result.get('env_info'),
        'yhat_lower':   result['yhat_lower'],
        'yhat_upper':   result['yhat_upper'],
        'confidence': result.get('confidence', _calc_confidence(result)),
        'is_fallback': result.get('is_fallback', False),
        'reservation_count': result.get('reservation_count', 0),
        'reservation_booked_hours': result.get('reservation_booked_hours', 0.0),
        'reservation_density': result.get('reservation_density', 0.0),
        'reservation_unique_rooms': result.get('reservation_unique_rooms', 0),
        'reservation_peak_overlap': result.get('reservation_peak_overlap', 0),
        'reservation_avg_duration_hours': result.get('reservation_avg_duration_hours', 0.0),
        'reservation_room_counts': result.get('reservation_room_counts', {}),
        'reservation_morning_count': result.get('reservation_morning_count', 0),
        'reservation_afternoon_count': result.get('reservation_afternoon_count', 0),
        'reservation_evening_count': result.get('reservation_evening_count', 0),
        'calibration_adjustment': result.get('calibration_adjustment', 0),
        'calibration_notes': result.get('calibration_notes', []),
        'shadow_model_name': shadow_model.get('model_name'),
        'shadow_yhat': shadow_model.get('yhat'),
        'shadow_confidence': shadow_model.get('confidence'),
        'shadow_family': shadow_model.get('family'),
        'shadow_neighbors': shadow_model.get('neighbor_count'),
        'shadow_avg_distance': shadow_model.get('avg_distance'),
        'shadow_models': {
            shadow_model.get('model_name'): shadow_model,
        } if shadow_model.get('model_name') else {},
        'shadow_blend_applied': bool(shadow_blend.get('applied')),
        'shadow_blend_weight': shadow_blend.get('weight'),
        'shadow_blend_reason': shadow_blend.get('reason'),
        'shadow_compare_days': shadow_blend.get('available_days'),
        'shadow_compare_mape_gap': shadow_blend.get('avg_mape_gap'),
    }
    params = _load_model_params()
    params['forecast_mode'] = forecast_mode
    preds_json  = json.dumps(predictions)
    params_json = json.dumps(params)
    cur = con.cursor()
    cur.execute("""
        INSERT INTO ska.forecast_results
          (forecast_date, model_version, predictions, mape, params)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (forecast_date, model_version)
        DO UPDATE SET predictions=%s, mape=%s, params=%s, created_at=NOW()
    """, (
        str(forecast_date), MODEL_VERSION, preds_json, mape, params_json,
        preds_json, mape, params_json,
    ))
    con.commit()
    cur.close()


def save_forecast_results(con, results, forecast_mode='daily'):
    """forecast_results를 단일 예측 원본으로 사용"""
    saved = 0
    for result in results:
        save_forecast_result(con, result['date'], result, mape=None, forecast_mode=forecast_mode)
        saved += 1
    return saved


def get_recent_mape(con, days=7):
    """최근 N일 평균 MAPE 조회 (forecast_results + revenue_daily 기준)"""
    try:
        row = _one(con, """
            WITH latest AS (
                SELECT DISTINCT ON (fr.forecast_date)
                    fr.forecast_date,
                    fr.predictions
                FROM ska.forecast_results fr
                WHERE fr.forecast_date >= current_date - %s
                ORDER BY fr.forecast_date, fr.created_at DESC
            )
            SELECT AVG(
                CASE
                    WHEN rd.actual_revenue > 0
                     AND (latest.predictions->>'yhat') IS NOT NULL
                    THEN ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / rd.actual_revenue) * 100
                    ELSE NULL
                END
            )
            FROM latest
            JOIN revenue_daily rd ON rd.date = latest.forecast_date
            WHERE rd.actual_revenue > 0
        """, (days,))
        return round(float(row[0]), 1) if row and row[0] is not None else None
    except Exception:
        return None


def _load_shadow_compare_signal(con, days=None):
    compare_days = int(days or FORECAST_RUNTIME.get('perModelAccuracyDays', 30) or 30)
    try:
        row = _one(con, """
            WITH latest AS (
                SELECT DISTINCT ON (fr.forecast_date)
                    fr.forecast_date,
                    fr.predictions
                FROM ska.forecast_results fr
                WHERE fr.forecast_date >= current_date - %s
                ORDER BY fr.forecast_date, fr.created_at DESC, fr.id DESC
            ),
            scored AS (
                SELECT
                    rd.actual_revenue,
                    (latest.predictions->>'yhat')::int AS primary_predicted_revenue,
                    (latest.predictions->>'shadow_yhat')::int AS shadow_predicted_revenue
                FROM latest
                JOIN ska.revenue_daily rd
                  ON rd.date = latest.forecast_date
                WHERE rd.actual_revenue > 0
                  AND (latest.predictions->>'yhat') IS NOT NULL
                  AND (latest.predictions->>'shadow_yhat') IS NOT NULL
            )
            SELECT
                COUNT(*) AS available_days,
                AVG(ABS((primary_predicted_revenue::float - actual_revenue) / NULLIF(actual_revenue, 0)) * 100) AS primary_avg_mape,
                AVG(ABS((shadow_predicted_revenue::float - actual_revenue) / NULLIF(actual_revenue, 0)) * 100) AS shadow_avg_mape
            FROM scored
        """, (compare_days,))
        available_days = int(row[0] or 0) if row else 0
        primary_avg_mape = float(row[1]) if row and row[1] is not None else None
        shadow_avg_mape = float(row[2]) if row and row[2] is not None else None
        avg_mape_gap = None
        if primary_avg_mape is not None and shadow_avg_mape is not None:
            avg_mape_gap = round(shadow_avg_mape - primary_avg_mape, 2)
        return {
            'available_days': available_days,
            'primary_avg_mape': round(primary_avg_mape, 2) if primary_avg_mape is not None else None,
            'shadow_avg_mape': round(shadow_avg_mape, 2) if shadow_avg_mape is not None else None,
            'avg_mape_gap': avg_mape_gap,
        }
    except Exception:
        return {
            'available_days': 0,
            'primary_avg_mape': None,
            'shadow_avg_mape': None,
            'avg_mape_gap': None,
        }


def _apply_shadow_blend(result, shadow_compare_signal):
    shadow_model = result.get('shadow_model') or {}
    blend_meta = {
        'applied': False,
        'weight': 0.0,
        'reason': 'shadow_blend_disabled',
        'available_days': shadow_compare_signal.get('available_days', 0),
        'avg_mape_gap': shadow_compare_signal.get('avg_mape_gap'),
    }
    result['shadow_blend'] = blend_meta

    if not FORECAST_RUNTIME.get('shadowBlendEnabled', False):
        return result
    if not shadow_model or shadow_model.get('yhat') is None:
        blend_meta['reason'] = 'shadow_missing'
        return result

    min_compare_days = int(FORECAST_RUNTIME.get('shadowBlendMinCompareDays', 5) or 5)
    required_gap = float(FORECAST_RUNTIME.get('shadowBlendRequiredMapeGap', 5.0) or 5.0)
    min_confidence = float(FORECAST_RUNTIME.get('shadowBlendMinConfidence', 0.35) or 0.35)
    blend_weight = float(FORECAST_RUNTIME.get('shadowBlendWeight', 0.25) or 0.25)

    if int(shadow_compare_signal.get('available_days') or 0) < min_compare_days:
        blend_meta['reason'] = 'shadow_compare_days_insufficient'
        return result
    avg_mape_gap = shadow_compare_signal.get('avg_mape_gap')
    if avg_mape_gap is None or avg_mape_gap > -required_gap:
        blend_meta['reason'] = 'shadow_gap_insufficient'
        return result
    shadow_confidence = float(shadow_model.get('confidence') or 0.0)
    if shadow_confidence < min_confidence:
        blend_meta['reason'] = 'shadow_confidence_low'
        return result

    primary_yhat = int(result.get('yhat') or 0)
    shadow_yhat = int(shadow_model.get('yhat') or 0)
    blended_yhat = round(primary_yhat * (1 - blend_weight) + shadow_yhat * blend_weight)
    result['yhat'] = max(0, blended_yhat)

    if result.get('yhat_lower') is not None:
        result['yhat_lower'] = max(0, min(int(result['yhat_lower']), result['yhat']))
    if result.get('yhat_upper') is not None:
        result['yhat_upper'] = max(int(result['yhat_upper']), result['yhat'])

    blend_meta.update({
        'applied': True,
        'weight': blend_weight,
        'reason': 'shadow_blend_applied',
    })
    return result


# ─── 예측 실행 ────────────────────────────────────────────────────────────────

def run_forecast(con, base_date, periods):
    """Prophet + SARIMA + SMA/EMA 앙상블 예측
    returns: list of result dicts (yhat = 앙상블 최종값)
    """
    weekday_avg = load_weekday_avg(con)
    calibration = _load_recent_calibration_stats(con)
    shadow_compare_signal = _load_shadow_compare_signal(con)
    hist_df = load_history(con)

    if len(hist_df) < MIN_TRAIN_DAYS:
        # 데이터 부족: quick_forecast만 사용
        print(f'[FORECAST] ⚠️ 데이터 부족({len(hist_df)}일) — SMA/EMA 빠른 예측 사용')
        results = []
        for i in range(periods):
            target_d = base_date + timedelta(days=i + 1)
            q = quick_forecast_sma(hist_df, target_d)
            duck_dow = (target_d.weekday() + 1) % 7
            base = weekday_avg.get(duck_dow, q['prediction'])
            reservation_signal = get_reservation_signal(con, str(target_d))
            results.append({
                'date':             target_d,
                'yhat':             q['prediction'],
                'yhat_prophet':     None,
                'yhat_sarima':      None,
                'yhat_quick':       q['prediction'],
                'base_forecast':    max(0, base),
                'env_score':        0,
                'yhat_lower':       round(q['prediction'] * 0.8),
                'yhat_upper':       round(q['prediction'] * 1.2),
                'is_fallback':      True,
                'reservation_count': reservation_signal['count'],
                'reservation_booked_hours': reservation_signal['booked_hours'],
                'reservation_density': reservation_signal['density'],
                'reservation_unique_rooms': reservation_signal['unique_rooms'],
                'reservation_peak_overlap': reservation_signal['peak_overlap'],
                'reservation_avg_duration_hours': reservation_signal['avg_duration_hours'],
                'reservation_room_counts': reservation_signal['room_counts'],
                'reservation_morning_count': reservation_signal['morning_count'],
                'reservation_afternoon_count': reservation_signal['afternoon_count'],
                'reservation_evening_count': reservation_signal['evening_count'],
                'calibration_adjustment': 0,
                'calibration_notes': [],
            })
            results[-1] = _apply_result_calibration(results[-1], calibration, target_d)
            results[-1]['shadow_model'] = _run_shadow_knn_prediction(con, target_d, results[-1])
            results[-1] = _apply_shadow_blend(results[-1], shadow_compare_signal)
        return results

    print(f'[FORECAST] 학습 데이터: {len(hist_df)}일 ({hist_df["ds"].min().date()}~{hist_df["ds"].max().date()})')

    # ── 동적 가중치 계산 (최근 30일 모델별 MAPE 기반) ──
    dynamic_weights = None
    try:
        per_model_acc = get_per_model_accuracy(con, days=30)
        if len(per_model_acc) >= 2:
            dynamic_weights = calculate_dynamic_weights(per_model_acc)
            if dynamic_weights:
                w_str = ' | '.join(f'{k}:{v:.0%}' for k, v in dynamic_weights.items())
                print(f'[FORECAST] 동적 가중치: {w_str}')
            else:
                print('[FORECAST] 동적 가중치: 기본값 사용 (데이터 부족)')
    except Exception:
        pass

    # ── SARIMA 예측 (periods <= 7) ──
    sarima_preds = None
    if periods <= 7:
        print('[FORECAST] SARIMA 예측 실행 중...')
        sarima_preds = forecast_sarima(hist_df, periods)
        if sarima_preds:
            print(f'[FORECAST] SARIMA 완료: {[round(v) for v in sarima_preds[:3]]}...')
        else:
            print('[FORECAST] SARIMA 비활성 — Prophet + SMA/EMA 앙상블')

    # ── Prophet 학습 ──
    model = build_model()
    with open(os.devnull, 'w') as devnull:
        old_stderr = sys.stderr
        sys.stderr = devnull
        try:
            model.fit(hist_df)
        finally:
            sys.stderr = old_stderr
    print('[FORECAST] Prophet 학습 완료')

    # ── 미래 DataFrame 구성 ──
    predict_start = base_date + timedelta(days=1)
    predict_end   = base_date + timedelta(days=periods)
    hist_last = hist_df['ds'].max().date()
    needed = max(periods, (predict_end - hist_last).days)
    future = model.make_future_dataframe(periods=needed, freq='D')
    env_map = load_future_env(con, predict_start, predict_end)
    hist_env_map = {}
    for _, row in hist_df.iterrows():
        d = row['ds'].strftime('%Y-%m-%d')
        hist_env_map[d] = {
            'exam_score':     row['exam_score'],
            'rain_prob':      row['rain_prob'],
            'vacation_flag':  row['vacation_flag'],
            'temperature':    row['temperature'],
            'bridge_holiday': row['bridge_holiday'],
        }
    future = fill_future_regressors(future, {**hist_env_map, **env_map})

    # ── Prophet 예측 ──
    forecast = model.predict(future)

    start_ts = pd.Timestamp(predict_start)
    end_ts   = pd.Timestamp(predict_end)
    filt = forecast[(forecast['ds'] >= start_ts) & (forecast['ds'] <= end_ts)].copy()

    results = []
    for i, (_, row) in enumerate(filt.iterrows()):
        target_d = row['ds'].date()
        d_str    = str(target_d)
        env_info = env_map.get(d_str, {})
        duck_dow = (target_d.weekday() + 1) % 7
        base = weekday_avg.get(duck_dow, round(row['yhat']))

        yhat_prophet = round(row['yhat'])
        yhat_upper   = max(0, round(row['yhat_upper']))
        yhat_lower   = max(0, round(row['yhat_lower']))

        if yhat_prophet <= 0 and yhat_upper > 0:
            yhat_prophet_final = round(yhat_upper * 0.5)
            is_fallback = True
        else:
            yhat_prophet_final = max(0, yhat_prophet)
            is_fallback = False

        # ── SMA/EMA 보조 예측 ──
        quick_info = quick_forecast_sma(hist_df, target_d)
        yhat_quick = quick_info['prediction']

        # ── SARIMA 값 ──
        yhat_sarima = None
        if sarima_preds is not None and i < len(sarima_preds):
            yhat_sarima = round(sarima_preds[i])

        # ── 앙상블 최종값 ──
        yhat_final = _ensemble_val(yhat_prophet_final, yhat_sarima, yhat_quick, i, dynamic_weights)

        # ── 예약 선행 지표 ──
        reservation_signal = get_reservation_signal(con, d_str)

        results.append({
            'date':              target_d,
            'yhat':              yhat_final,
            'yhat_prophet':      yhat_prophet_final,
            'yhat_sarima':       yhat_sarima,
            'yhat_quick':        yhat_quick,
            'base_forecast':     max(0, base),
            'env_score':         env_info.get('exam_score', 0),
            'env_info':          env_info,
            'yhat_lower':        yhat_lower,
            'yhat_upper':        yhat_upper,
            'is_fallback':       is_fallback,
            'reservation_count': reservation_signal['count'],
            'reservation_booked_hours': reservation_signal['booked_hours'],
            'reservation_density': reservation_signal['density'],
            'reservation_unique_rooms': reservation_signal['unique_rooms'],
            'reservation_peak_overlap': reservation_signal['peak_overlap'],
            'reservation_avg_duration_hours': reservation_signal['avg_duration_hours'],
            'reservation_room_counts': reservation_signal['room_counts'],
            'reservation_morning_count': reservation_signal['morning_count'],
            'reservation_afternoon_count': reservation_signal['afternoon_count'],
            'reservation_evening_count': reservation_signal['evening_count'],
            'calibration_adjustment': 0,
            'calibration_notes': [],
        })

        results[-1] = _apply_result_calibration(results[-1], calibration, target_d)
        results[-1]['shadow_model'] = _run_shadow_knn_prediction(con, target_d, results[-1])
        results[-1] = _apply_shadow_blend(results[-1], shadow_compare_signal)

    print(f'[FORECAST] 앙상블 예측 완료: {len(results)}일')
    return results


def _calc_confidence(r):
    """신뢰구간 폭 기반 확신도 (0.0~1.0)"""
    if r['yhat'] <= 0:
        return 0.0
    spread = r['yhat_upper'] - r['yhat_lower']
    ratio  = spread / r['yhat']
    return max(0.0, round(1.0 - ratio / 2, 3))


SHADOW_FEATURE_COLUMNS = [
    'weekday',
    'month',
    'day_of_month',
    'is_weekend',
    'reservation_count',
    'reservation_booked_hours',
    'reservation_unique_rooms',
    'reservation_peak_overlap',
    'reservation_morning_count',
    'reservation_afternoon_count',
    'reservation_evening_count',
    'exam_score',
    'rain_prob',
    'temperature',
    'vacation_flag',
    'bridge_holiday_flag',
]


def _load_shadow_training_rows(con, days=None):
    lookback_days = days or int(FORECAST_RUNTIME['perModelAccuracyDays'])
    try:
        rows = _qry(con, """
            SELECT
                date,
                target_revenue,
                weekday,
                month,
                day_of_month,
                COALESCE(is_weekend, false) AS is_weekend,
                COALESCE(reservation_count, total_reservations, 0) AS reservation_count,
                COALESCE(reservation_booked_hours, 0.0) AS reservation_booked_hours,
                COALESCE(reservation_unique_rooms, 0) AS reservation_unique_rooms,
                COALESCE(reservation_peak_overlap, 0) AS reservation_peak_overlap,
                COALESCE(reservation_morning_count, 0) AS reservation_morning_count,
                COALESCE(reservation_afternoon_count, 0) AS reservation_afternoon_count,
                COALESCE(reservation_evening_count, 0) AS reservation_evening_count,
                COALESCE(exam_score, 0) AS exam_score,
                COALESCE(rain_prob, 0.0) AS rain_prob,
                COALESCE(temperature, %s) AS temperature,
                COALESCE(vacation_flag, false) AS vacation_flag,
                COALESCE(bridge_holiday_flag, false) AS bridge_holiday_flag
            FROM ska.training_feature_daily
            WHERE date >= current_date - %s
              AND date < current_date
              AND target_revenue IS NOT NULL
              AND target_revenue > 0
            ORDER BY date
        """, (TEMP_DEFAULT, lookback_days))
        return rows
    except Exception as e:
        print(f'[FORECAST] ⚠️ shadow 학습 데이터 조회 실패: {e}')
        return []


def _build_shadow_feature_row(target_date, result):
    env_info = result.get('env_info') or {}
    return {
        'weekday': target_date.isoweekday(),
        'month': target_date.month,
        'day_of_month': target_date.day,
        'is_weekend': 1 if target_date.weekday() >= 5 else 0,
        'reservation_count': int(result.get('reservation_count', 0) or 0),
        'reservation_booked_hours': float(result.get('reservation_booked_hours', 0.0) or 0.0),
        'reservation_unique_rooms': int(result.get('reservation_unique_rooms', 0) or 0),
        'reservation_peak_overlap': int(result.get('reservation_peak_overlap', 0) or 0),
        'reservation_morning_count': int(result.get('reservation_morning_count', 0) or 0),
        'reservation_afternoon_count': int(result.get('reservation_afternoon_count', 0) or 0),
        'reservation_evening_count': int(result.get('reservation_evening_count', 0) or 0),
        'exam_score': int(env_info.get('exam_score', 0) or 0),
        'rain_prob': float(env_info.get('rain_prob', 0.0) or 0.0),
        'temperature': float(env_info.get('temperature', TEMP_DEFAULT) or TEMP_DEFAULT),
        'vacation_flag': 1 if env_info.get('vacation_flag') else 0,
        'bridge_holiday_flag': 1 if env_info.get('bridge_holiday') else 0,
    }


def _normalize_shadow_dataset(training_rows):
    data = []
    for row in training_rows:
        data.append({
            'target_revenue': float(row[1] or 0.0),
            'features': {
                'weekday': float(row[2] or 0),
                'month': float(row[3] or 0),
                'day_of_month': float(row[4] or 0),
                'is_weekend': 1.0 if row[5] else 0.0,
                'reservation_count': float(row[6] or 0),
                'reservation_booked_hours': float(row[7] or 0.0),
                'reservation_unique_rooms': float(row[8] or 0),
                'reservation_peak_overlap': float(row[9] or 0),
                'reservation_morning_count': float(row[10] or 0),
                'reservation_afternoon_count': float(row[11] or 0),
                'reservation_evening_count': float(row[12] or 0),
                'exam_score': float(row[13] or 0),
                'rain_prob': float(row[14] or 0.0),
                'temperature': float(row[15] or TEMP_DEFAULT),
                'vacation_flag': 1.0 if row[16] else 0.0,
                'bridge_holiday_flag': 1.0 if row[17] else 0.0,
            },
        })
    return data


def _shadow_feature_stats(dataset):
    stats = {}
    for key in SHADOW_FEATURE_COLUMNS:
        values = [float(item['features'][key]) for item in dataset]
        if not values:
            stats[key] = {'mean': 0.0, 'std': 1.0}
            continue
        mean_val = sum(values) / len(values)
        variance = sum((value - mean_val) ** 2 for value in values) / len(values)
        stats[key] = {
            'mean': mean_val,
            'std': math.sqrt(variance) or 1.0,
        }
    return stats


def _scaled_distance(a, b, stats):
    total = 0.0
    for key in SHADOW_FEATURE_COLUMNS:
        std = stats[key]['std'] or 1.0
        delta = (float(a.get(key, 0.0)) - float(b.get(key, 0.0))) / std
        total += delta * delta
    return math.sqrt(total)


def _run_shadow_knn_prediction(con, target_date, result):
    if not FORECAST_RUNTIME.get('shadowModelEnabled', True):
        return None

    training_rows = _load_shadow_training_rows(con)
    min_rows = int(FORECAST_RUNTIME.get('shadowMinimumTrainRows', 28) or 28)
    if len(training_rows) < min_rows:
        return None

    dataset = _normalize_shadow_dataset(training_rows)
    stats = _shadow_feature_stats(dataset)
    target_features = _build_shadow_feature_row(target_date, result)

    distances = []
    for item in dataset:
        dist = _scaled_distance(item['features'], target_features, stats)
        distances.append((dist, item['target_revenue']))
    distances.sort(key=lambda entry: entry[0])

    neighbor_count = max(3, int(FORECAST_RUNTIME.get('shadowNeighborCount', 7) or 7))
    neighbors = distances[:neighbor_count]
    if not neighbors:
        return None

    weighted_sum = 0.0
    weight_total = 0.0
    neighbor_targets = []
    for distance, target_revenue in neighbors:
        weight = 1.0 / max(distance, 0.25)
        weighted_sum += target_revenue * weight
        weight_total += weight
        neighbor_targets.append(target_revenue)

    if weight_total <= 0:
        return None

    yhat = round(weighted_sum / weight_total)
    spread = max(neighbor_targets) - min(neighbor_targets) if len(neighbor_targets) > 1 else 0.0
    base = max(yhat, 1)
    spread_ratio = spread / base
    avg_distance = sum(distance for distance, _ in neighbors) / len(neighbors)
    confidence = max(0.0, min(0.95, round(0.82 - min(0.45, spread_ratio * 0.35) - min(0.25, avg_distance * 0.03), 3)))

    return {
        'model_name': FORECAST_RUNTIME.get('shadowModelName', 'knn-shadow-v1'),
        'family': 'knn_regressor',
        'yhat': max(0, yhat),
        'neighbor_count': len(neighbors),
        'avg_distance': round(avg_distance, 3),
        'confidence': confidence,
        'feature_keys': SHADOW_FEATURE_COLUMNS,
    }


# ─── 텔레그램 포맷 ────────────────────────────────────────────────────────────

def format_daily(result, base_date, recent_mape=None, weather_impact=None):
    """익일 앙상블 예측 포맷 (🔮 형식)"""
    r    = result[0]
    d    = r['date']
    wd   = WEEKDAY_KO[d.weekday()]
    conf = r.get('confidence', _calc_confidence(r))

    # 앙상블 유무
    has_sarima = r.get('yhat_sarima') is not None
    has_prophet = r.get('yhat_prophet') is not None

    lines = [
        '🔮 내일 매출 예측',
        '═' * 19,
        f'📅 {d.month}월 {d.day}일 ({wd}) 예상',
        '',
    ]

    if has_prophet or has_sarima:
        lines.append('■ 예측 모델별')
        if has_prophet:
            mape_str = f' (MAPE {recent_mape}%)' if recent_mape else ''
            lines.append(f'  Prophet:  {r["yhat_prophet"]:,}원{mape_str}')
        if has_sarima:
            lines.append(f'  SARIMA:   {r["yhat_sarima"]:,}원')
        lines.append(f'  SMA/EMA:  {r["yhat_quick"]:,}원')
        lines.append('─' * 21)
        lines.append(f'  앙상블:   {r["yhat"]:,}원 ★')
        lines.append('')
    else:
        # 데이터 부족 — quick만
        lines.append(f'  SMA/EMA:  {r["yhat"]:,}원 (데이터 부족, 빠른 예측)')
        lines.append('')

    # 보정 요인
    env = r.get('env_info', {})
    env_score = r.get('env_score', 0)
    res_cnt   = r.get('reservation_count', 0)
    res_hours = r.get('reservation_booked_hours', 0.0)
    res_rooms = r.get('reservation_unique_rooms', 0)
    res_peak  = r.get('reservation_peak_overlap', 0)
    res_avg_duration = r.get('reservation_avg_duration_hours', 0.0)
    res_room_counts = r.get('reservation_room_counts') or {}
    res_morning = r.get('reservation_morning_count', 0)
    res_afternoon = r.get('reservation_afternoon_count', 0)
    res_evening = r.get('reservation_evening_count', 0)

    lines.append('■ 보정 요인')
    lines.append(f'  요일({wd}): 주간 패턴 반영 📅')

    temp = env.get('temperature', TEMP_DEFAULT)
    rain = env.get('rain_prob', 0.0)
    if rain > 0.3:
        lines.append(f'  날씨(강수 {int(rain*100)}%  {temp:.0f}°C): 감소 요인 🌧️')
    else:
        lines.append(f'  날씨(맑음 {temp:.0f}°C): 보정 없음 ☀️')

    if res_cnt > 0:
        lines.append(f'  예약 현황: {res_cnt}건 / {res_hours:.1f}시간 / {res_rooms}룸 📋')
        lines.append(f'  예약 구조: 피크겹침 {res_peak}건 / 평균 {res_avg_duration:.1f}시간')
        lines.append(
            f'  룸 분포: A1 {res_room_counts.get("A1", 0)} / '
            f'A2 {res_room_counts.get("A2", 0)} / B {res_room_counts.get("B", 0)}'
        )
        lines.append(f'  시간대: 오전 {res_morning} / 오후 {res_afternoon} / 저녁 {res_evening}')
    else:
        lines.append('  예약 현황: 조회 없음')

    if env_score > 0:
        lines.append(f'  시험 기간: +{env_score}점 📚')
    elif env.get('vacation_flag'):
        lines.append('  방학 중 📚')
    else:
        lines.append('  이벤트: 없음')

    calibration_adjustment = r.get('calibration_adjustment', 0)
    calibration_notes = r.get('calibration_notes') or []
    if calibration_adjustment:
        note_suffix = f" ({', '.join(calibration_notes)})" if calibration_notes else ''
        lines.append(f'  최근 오차/예약 보정: {calibration_adjustment:+,}원{note_suffix}')

    lines.append('')

    # 신뢰 구간
    lines.append('■ 신뢰 구간')
    lines.append(f'  80%: {r["yhat_lower"]:,} ~ {r["yhat_upper"]:,}원')
    lines.append(f'  확신도: {"█" * round(conf*10)}{"░" * (10-round(conf*10))} ({conf*100:.0f}%)')
    # 실시간 날씨 영향 (weather.py 제공 시)
    if weather_impact and weather_impact[0] != 'neutral':
        impact, score, desc = weather_impact
        icon = '📈' if impact == 'positive' else '📉'
        lines.append(f'  실시간 날씨: {icon} {desc}')
        lines.append('')

    try:
        prompt = f"""당신은 스터디카페 매출 예측 분석가입니다.
내일 예상 매출: {r["yhat"]:,}원
최근 MAPE: {recent_mape if recent_mape is not None else '없음'}
예약 건수: {res_cnt}건
확신도: {conf*100:.0f}%

예측 해석을 한국어 1줄로 간결하게 작성하세요."""
        proc = subprocess.run(
            [
                'node',
                GEMMA_PILOT_CLI,
                '--team=ska',
                '--purpose=gemma-insight',
                '--bot=forecast',
                '--requestType=daily-forecast-insight',
                '--maxTokens=150',
                '--temperature=0.7',
                '--timeoutMs=20000',
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=22,
            cwd=PROJECT_ROOT,
        )
        insight = sanitize_insight_line((proc.stdout or '').strip())
        if not insight:
            insight = build_daily_fallback_insight(r, recent_mape=recent_mape)
        if insight:
            lines.append(f'🔍 AI: {insight}')
            lines.append('')
    except Exception as e:
        print(f'[forecast] gemma 인사이트 생략: {e}', file=sys.stderr)
        fallback_insight = build_daily_fallback_insight(r, recent_mape=recent_mape)
        if fallback_insight:
            lines.append(f'🔍 AI: {fallback_insight}')
            lines.append('')

    lines.append('═' * 19)

    return '\n'.join(lines)


def format_weekly(results, base_date):
    """주간 예측 포맷"""
    lines = [
        '📊 포캐스트 주간 예측 리포트',
        '─' * 15,
        '📅 향후 7일 예상 매출',
        '',
    ]
    total = 0
    for r in results:
        d    = r['date']
        wd   = WEEKDAY_KO[d.weekday()]
        total += r['yhat']
        lines.append(
            f'  {d.month}/{d.day}({wd})  {r["yhat"]:>8,}원'
            f'  ({r["yhat_lower"]:,}~{r["yhat_upper"]:,})'
        )
    daily_avg = total // len(results)
    lines += ['', f'💰 7일 합계: ~{total:,}원', f'   일 평균: ~{daily_avg:,}원', '']

    try:
        prompt = f"""당신은 스터디카페 매출 예측 분석가입니다.
향후 7일 예상 매출 합계: {total:,}원
일 평균 예상 매출: {daily_avg:,}원
최고 예상 일매출: {max(r['yhat'] for r in results):,}원
최저 예상 일매출: {min(r['yhat'] for r in results):,}원

주간 예측 해석을 한국어 1줄로 간결하게 작성하세요."""
        proc = subprocess.run(
            [
                'node',
                GEMMA_PILOT_CLI,
                '--team=ska',
                '--purpose=gemma-insight',
                '--bot=forecast',
                '--requestType=weekly-forecast-insight',
                '--maxTokens=150',
                '--temperature=0.7',
                '--timeoutMs=20000',
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=22,
            cwd=PROJECT_ROOT,
        )
        insight = sanitize_insight_line((proc.stdout or '').strip())
        if not insight:
            insight = build_period_fallback_insight('향후 7일', total, daily_avg, results)
        if insight:
            lines += [f'🔍 AI: {insight}', '']
    except Exception as e:
        print(f'[forecast] weekly 인사이트 생략: {e}', file=sys.stderr)
        fallback_insight = build_period_fallback_insight('향후 7일', total, daily_avg, results)
        if fallback_insight:
            lines += [f'🔍 AI: {fallback_insight}', '']
    return '\n'.join(lines)


def format_monthly(results, base_date):
    """월간 예측 포맷"""
    total = sum(r['yhat'] for r in results)
    avg   = total // len(results)
    low   = sum(r['yhat_lower'] for r in results)
    high  = sum(r['yhat_upper'] for r in results)

    lines = [
        '📊 포캐스트 월간 예측 리포트',
        '─' * 15,
        '📅 향후 30일 예상 매출',
        '',
        f'💰 예측 합계: ~{total:,}원',
        f'   범위: {low:,}원 ~ {high:,}원',
        f'   일 평균: ~{avg:,}원',
        '',
    ]
    for week in range(0, len(results), 7):
        chunk = results[week:week + 7]
        w_total = sum(r['yhat'] for r in chunk)
        start_d = chunk[0]['date']
        end_d   = chunk[-1]['date']
        lines.append(
            f'  {start_d.month}/{start_d.day}~{end_d.month}/{end_d.day}  '
            f'{w_total:,}원'
        )
    lines.append('')

    try:
        prompt = f"""당신은 스터디카페 매출 예측 분석가입니다.
향후 30일 예상 매출 합계: {total:,}원
일 평균 예상 매출: {avg:,}원
최고 예상 일매출: {max(r['yhat'] for r in results):,}원
최저 예상 일매출: {min(r['yhat'] for r in results):,}원

월간 예측 해석을 한국어 1줄로 간결하게 작성하세요."""
        proc = subprocess.run(
            [
                'node',
                GEMMA_PILOT_CLI,
                '--team=ska',
                '--purpose=gemma-insight',
                '--bot=forecast',
                '--requestType=monthly-forecast-insight',
                '--maxTokens=150',
                '--temperature=0.7',
                '--timeoutMs=20000',
            ],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=22,
            cwd=PROJECT_ROOT,
        )
        insight = sanitize_insight_line((proc.stdout or '').strip())
        if not insight:
            insight = build_period_fallback_insight('향후 30일', total, avg, results)
        if insight:
            lines += [f'🔍 AI: {insight}', '']
    except Exception as e:
        print(f'[forecast] monthly 인사이트 생략: {e}', file=sys.stderr)
        fallback_insight = build_period_fallback_insight('향후 30일', total, avg, results)
        if fallback_insight:
            lines += [f'🔍 AI: {fallback_insight}', '']
    return '\n'.join(lines)


# ─── 월간 모델 진단 (ska-011/013) ────────────────────────────────────────────

def _get_accuracy_history(con, days=90):
    """최근 N일 정확도 조회 (forecast_results + revenue_daily 기준)"""
    try:
        rows = _qry(con, """
            WITH latest AS (
                SELECT DISTINCT ON (fr.forecast_date)
                    fr.forecast_date,
                    fr.model_version,
                    fr.predictions
                FROM ska.forecast_results fr
                WHERE fr.forecast_date >= current_date - %s
                ORDER BY fr.forecast_date, fr.created_at DESC
            )
            SELECT
                latest.forecast_date,
                rd.actual_revenue,
                (latest.predictions->>'yhat')::int AS predicted_revenue,
                rd.actual_revenue - (latest.predictions->>'yhat')::int AS error,
                CASE
                    WHEN rd.actual_revenue > 0
                    THEN ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / rd.actual_revenue) * 100
                    ELSE NULL
                END AS mape,
                latest.model_version
            FROM latest
            JOIN revenue_daily rd ON rd.date = latest.forecast_date
            WHERE rd.actual_revenue IS NOT NULL
            ORDER BY latest.forecast_date
        """, (days,))
        return [{'date': str(r[0]), 'actual': r[1], 'predicted': r[2],
                 'error': r[3], 'mape': r[4], 'model': r[5]}
                for r in rows]
    except Exception:
        return []


def _calc_weekday_bias(accuracy_list):
    """요일별 평균 오차 계산"""
    from collections import defaultdict
    buckets = defaultdict(list)
    for a in accuracy_list:
        if a['error'] is not None:
            wd = date_type.fromisoformat(a['date']).weekday()
            buckets[wd].append(a['error'])
    return {wd: round(sum(v) / len(v)) for wd, v in buckets.items()}


def _run_cross_validation(hist_df):
    """Prophet 교차검증 — 데이터 부족 시 None 반환"""
    try:
        from prophet.diagnostics import cross_validation, performance_metrics
        model = build_model()
        with open(os.devnull, 'w') as devnull:
            old_stderr = sys.stderr
            sys.stderr = devnull
            try:
                model.fit(hist_df)
                df_cv = cross_validation(
                    model,
                    initial='60 days',
                    period='14 days',
                    horizon='7 days',
                    disable_tqdm=True,
                )
            finally:
                sys.stderr = old_stderr
        df_p = performance_metrics(df_cv)
        return {
            'mape':     round(df_p['mape'].mean() * 100, 1),
            'rmse':     round(df_p['rmse'].mean()),
            'coverage': round(df_p['coverage'].mean() * 100, 1),
            'n_folds':  len(df_cv['cutoff'].unique()),
        }
    except Exception as e:
        print(f'[REVIEW] ⚠️ 교차검증 실패: {e}')
        return None


def auto_tune_prophet(hist_df):
    """MAPE 기반 자동 파라미터 튜닝 (--mode=review, MAPE > 15%)
    최근 7일을 검증 세트로 사용, 20개 조합 그리드 서치
    반환: (best_params, best_mape)
    """
    def calc_mape(actual, predicted):
        valid = [(a, p) for a, p in zip(actual, predicted) if a > 0]
        if not valid:
            return float('inf')
        return sum(abs(a - p) / a for a, p in valid) / len(valid) * 100

    param_grid = {
        'changepoint_prior_scale': [0.001, 0.01, 0.05, 0.1, 0.5],
        'seasonality_prior_scale': [0.01, 0.1, 1.0, 10.0],
    }

    train = hist_df.iloc[:-7]
    valid = hist_df.iloc[-7:]

    if len(train) < MIN_TRAIN_DAYS:
        print('[TUNE] ⚠️ 학습 데이터 부족 — 튜닝 생략')
        return {}, float('inf')

    best_mape   = float('inf')
    best_params = {}
    total = len(param_grid['changepoint_prior_scale']) * len(param_grid['seasonality_prior_scale'])
    tried = 0

    print(f'[TUNE] 파라미터 그리드 서치 시작 ({total}개 조합)...')

    for cps in param_grid['changepoint_prior_scale']:
        for sps in param_grid['seasonality_prior_scale']:
            tried += 1
            try:
                m = build_model({'changepoint_prior_scale': cps, 'seasonality_prior_scale': sps})
                with open(os.devnull, 'w') as devnull:
                    old_stderr = sys.stderr
                    sys.stderr = devnull
                    try:
                        m.fit(train)
                        pred = m.predict(valid[['ds']])
                    finally:
                        sys.stderr = old_stderr
                mape = calc_mape(valid['y'].values.tolist(), pred['yhat'].values.tolist())
                if mape < best_mape:
                    best_mape   = mape
                    best_params = {'changepoint_prior_scale': cps, 'seasonality_prior_scale': sps}
            except Exception:
                continue

    print(f'[TUNE] 완료: 최적 파라미터 {best_params}  MAPE={best_mape:.1f}%')
    return best_params, best_mape


def _call_llm_diagnosis(cv_metrics, accuracy_list, weekday_bias):
    """OpenAI GPT-4o로 모델 진단 요청"""
    import os
    try:
        from openai import OpenAI
        import openai
    except ImportError:
        return '(openai 패키지 미설치)'

    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return '(OPENAI_API_KEY 미설정)'

    SYSTEM_PROMPT = (
        "당신은 스터디카페 매출 예측 모델(Prophet) 전문 진단 AI입니다. "
        "성능 지표 데이터를 분석하여 한국어로 간결하고 실용적인 개선 방안을 제시합니다."
    )

    cv_text = '교차검증 미실시 (데이터 부족)' if not cv_metrics else (
        f"평균 MAPE: {cv_metrics['mape']:.1f}%\n"
        f"평균 RMSE: {cv_metrics['rmse']:,}원\n"
        f"80% 신뢰구간 커버리지: {cv_metrics['coverage']:.1f}%\n"
        f"폴드 수: {cv_metrics['n_folds']}개"
    )

    wd_names = ['월', '화', '수', '목', '금', '토', '일']
    bias_text = '\n'.join(
        f"  {wd_names[wd]}: {bias:+,}원 ({'과소예측' if bias > 0 else '과대예측'})"
        for wd, bias in sorted(weekday_bias.items())
    ) if weekday_bias else '  데이터 없음'

    recent_mapes = [a['mape'] for a in accuracy_list[-30:] if a['mape'] is not None]
    mape_trend = f"최근 30일 평균 MAPE: {sum(recent_mapes)/len(recent_mapes):.1f}%" \
        if recent_mapes else "최근 MAPE 데이터 없음"

    # RAG에서 과거 예측 오류 패턴 검색
    rag_context = ''
    if _rag:
        try:
            hits = _rag.search('operations', '매출 예측 오류 MAPE 패턴', limit=3, threshold=FORECAST_RUNTIME['llmDiagnosisRagThreshold'])
            if hits:
                rag_context = '\n\n[RAG: 과거 유사 예측 이슈]\n' + '\n'.join(
                    f'- {h["content"][:200]}' for h in hits
                )
        except Exception:
            pass

    user_content = f"""Prophet 매출 예측 모델 월간 성능 평가 데이터입니다.

[교차검증 결과]
{cv_text}

[요일별 예측 편향 (최근 90일)]
{bias_text}

[최근 추이]
{mape_trend}{rag_context}

현재 모델: prophet-v3 (+ SARIMA/SMA/EMA 앙상블)
  - seasonality_mode: additive
  - regressors: exam_score, rain_prob, vacation_flag, temperature
  - weekly_seasonality: True

다음을 한국어로 간결하게 답해줘 (최대 6줄):
1. 모델 성능 평가 (어느 요일/구간이 취약한지)
2. 핵심 원인 추정
3. 파라미터 조정 권고
4. prophet-v4 업그레이드 시점 권고"""

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model='gpt-4o',
            max_tokens=300,
            temperature=0.1,
            messages=[
                {'role': 'system', 'content': SYSTEM_PROMPT},
                {'role': 'user',   'content': user_content},
            ],
        )
        return resp.choices[0].message.content.strip()
    except openai.RateLimitError:
        return '(API 한도 초과 — 잠시 후 재시도)'
    except openai.AuthenticationError:
        return '(OPENAI_API_KEY 인증 실패)'
    except Exception as e:
        return f'(LLM 호출 실패: {e})'


def format_monthly_review(base_date, cv_metrics, weekday_bias, accuracy_list, llm_diagnosis, tune_result=None):
    """월간 모델 진단 텔레그램 포맷"""
    wd_names = ['월', '화', '수', '목', '금', '토', '일']
    m, y = base_date.month, base_date.year

    lines = [
        '🔬 포캐스트 월간 모델 진단',
        '─' * 15,
        f'📅 {y}년 {m}월 리뷰  (모델: {MODEL_VERSION})',
        '',
    ]

    if cv_metrics:
        mape = cv_metrics['mape']
        grade = '✅ 양호' if mape <= FORECAST_RUNTIME['monthlyReviewGradeGood'] else ('🟡 주의' if mape <= FORECAST_RUNTIME['monthlyReviewGradeWarn'] else '🔴 개선 필요')
        lines += [
            f'📊 교차검증 ({cv_metrics["n_folds"]}폴드)',
            f'   MAPE: {mape:.1f}%  {grade}',
            f'   RMSE: {cv_metrics["rmse"]:,}원',
            f'   커버리지: {cv_metrics["coverage"]:.1f}% (목표 80%)',
            '',
        ]
    else:
        lines += ['📊 교차검증: 데이터 부족 (60일+ 필요)', '']

    if weekday_bias:
        lines.append('📉 요일별 예측 편향')
        for wd in range(7):
            if wd in weekday_bias:
                bias = weekday_bias[wd]
                flag = '  ⚠️' if abs(bias) > FORECAST_RUNTIME['weekdayBiasAlertAmount'] else '  '
                direction = '과소' if bias > 0 else '과대'
                lines.append(f'  {flag}{wd_names[wd]}: {bias:+,}원 ({direction}예측)')
        lines.append('')

    # 자동 튜닝 결과
    if tune_result:
        best_params, best_mape, prev_mape = tune_result
        if best_params:
            improvement = f'{prev_mape:.1f}% → {best_mape:.1f}%' if prev_mape else f'MAPE {best_mape:.1f}%'
            lines += [
                f'🔧 자동 파라미터 튜닝',
                f'   결과: {improvement}',
                f'   cps={best_params.get("changepoint_prior_scale")}  '
                f'sps={best_params.get("seasonality_prior_scale")}',
                f'   ✅ 새 파라미터 저장 완료',
                '',
            ]

    lines += [
        '🤖 AI 진단',
        '─' * 15,
    ]
    for line in llm_diagnosis.split('\n'):
        lines.append(f'  {line}' if line.strip() else '')
    lines.append('')

    return '\n'.join(lines)


def run_monthly_review(base_date_str=None):
    """월간 모델 진단 실행 (ska-011) + 자동 파라미터 튜닝 (ska-014)"""
    base_date = date_type.fromisoformat(base_date_str) if base_date_str else date_type.today()
    print(f'[REVIEW] 월간 모델 진단 시작: {base_date}')

    con = psycopg2.connect(PG_SKA)
    try:
        hist_df = load_history(con)
        accuracy_list = _get_accuracy_history(con, days=90)
    finally:
        con.close()

    print(f'[REVIEW] 학습 데이터: {len(hist_df)}일 / 정확도 기록: {len(accuracy_list)}건')

    cv_metrics = None
    if len(hist_df) >= 75:
        print('[REVIEW] 교차검증 실행 중...')
        cv_metrics = _run_cross_validation(hist_df)
        if cv_metrics:
            print(f'[REVIEW] CV 완료: MAPE={cv_metrics["mape"]:.1f}% RMSE={cv_metrics["rmse"]:,}')
    else:
        print(f'[REVIEW] ⚠️ 교차검증 스킵: 데이터 {len(hist_df)}일 < 75일')

    weekday_bias = _calc_weekday_bias(accuracy_list)

    # ── 자동 파라미터 튜닝 (MAPE > 15%) ──
    tune_result = None
    current_mape = cv_metrics['mape'] if cv_metrics else None
    if current_mape is not None and current_mape > 15.0 and len(hist_df) >= MIN_TRAIN_DAYS + 7:
        print(f'[REVIEW] MAPE {current_mape:.1f}% > 15% — 자동 파라미터 튜닝 실행')
        best_params, best_mape = auto_tune_prophet(hist_df)
        if best_params and best_mape < current_mape:
            _save_model_params(best_params)
            print(f'[REVIEW] 튜닝 완료: {current_mape:.1f}% → {best_mape:.1f}%')
            tune_result = (best_params, best_mape, current_mape)
        else:
            print(f'[REVIEW] 튜닝 결과 개선 없음 — 기존 파라미터 유지')
    elif current_mape is not None:
        print(f'[REVIEW] MAPE {current_mape:.1f}% ≤ 15% — 파라미터 튜닝 불필요')

    print('[REVIEW] LLM 모델 진단 요청 중...')
    llm_diagnosis = _call_llm_diagnosis(cv_metrics, accuracy_list, weekday_bias)
    print('[REVIEW] LLM 응답 완료')

    report = format_monthly_review(base_date, cv_metrics, weekday_bias, accuracy_list, llm_diagnosis, tune_result)
    print(report)

    # RAG: 월간 리뷰 결과 저장
    if _rag:
        try:
            mape_str = f'MAPE {cv_metrics["mape"]:.1f}%' if cv_metrics else 'CV 미실시'
            rag_summary = (
                f'[월간 포캐스트 리뷰 {base_date.strftime("%Y-%m")}] '
                f'{mape_str} | LLM진단: {llm_diagnosis[:200]}'
            )
            _rag.store('operations', rag_summary, {
                'date':  str(base_date),
                'type':  'monthly_review',
                'mape':  cv_metrics['mape'] if cv_metrics else None,
                'model': MODEL_VERSION,
            }, 'forecast')
            print('[REVIEW] ✅ [RAG] 월간 리뷰 결과 저장 완료')
        except Exception as e:
            print(f'[REVIEW] ⚠️ [RAG] 저장 실패 (무시): {e}')

    return report


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run(mode='daily', base_date_str=None, output_json=False):
    base_date = date_type.fromisoformat(base_date_str) if base_date_str \
                else date_type.today()

    mode_periods = {'daily': 1, 'weekly': 7, 'monthly': 30}
    periods = mode_periods.get(mode, 1)

    print(f'[FORECAST] 기준: {base_date}  모드: {mode}  기간: {periods}일')

    con = psycopg2.connect(PG_SKA)

    try:
        # forecast_results 테이블 보장
        ensure_forecast_results_table(con)
        if ensure_training_feature_table:
            ensure_training_feature_table(con)

        results = run_forecast(con, base_date, periods)
        saved   = save_forecast_results(con, results, forecast_mode=mode)
        print(f'[FORECAST] ✅ {saved}건 저장 → forecast_results')
        if sync_training_feature_store:
            synced = sync_training_feature_store(con, days=365)
            print(f'[FORECAST] ✅ training_feature_daily 동기화 ({synced}행 대상)')
        recent_mape = get_recent_mape(con, days=7)

    except ValueError as e:
        print(f'[FORECAST] ❌ {e}')
        return None
    finally:
        con.close()

    for r in results:
        r['confidence'] = 0.15 if r.get('is_fallback') else _calc_confidence(r)

    if output_json:
        out = [{**r, 'date': str(r['date'])} for r in results]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return results

    # 날씨 영향 분류 (daily 모드, env_info 재사용 — API 재호출 없음)
    weather_impact = None
    if mode == 'daily' and results:
        try:
            from bots.ska.src.weather import classify_weather_impact as _cwi
            weather_impact = _cwi(results[0].get('env_info', {}))
            print(f'[FORECAST] 날씨 영향: {weather_impact[0]} ({weather_impact[1]:+d}pt) — {weather_impact[2]}')
        except Exception:
            pass

    if mode == 'daily':
        print(format_daily(results, base_date, recent_mape=recent_mape, weather_impact=weather_impact))
    elif mode == 'weekly':
        print(format_weekly(results, base_date))
    elif mode == 'monthly':
        print(format_monthly(results, base_date))

    return results


if __name__ == '__main__':
    mode, base_date, output_json = parse_args()
    if mode == 'review':
        run_monthly_review(base_date)
    else:
        run(mode, base_date, output_json)
