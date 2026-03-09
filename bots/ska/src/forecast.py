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
import warnings
import psycopg2
import pandas as pd
from datetime import date as date_type, timedelta

# RAG 클라이언트 (실패해도 예측 기능에 영향 없음)
try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))
    from bots.ska.lib.rag_client import RagClient as _RagClient
    _rag = _RagClient()
except Exception:
    _rag = None

warnings.filterwarnings('ignore')  # Prophet Stan 경고 억제

PG_SKA = "dbname=jay options='-c search_path=ska,public'"

MODEL_VERSION  = 'prophet-v3'
TEMP_DEFAULT   = 15.0   # 기온 기본값 (°C) — 수집 누락 시
MIN_TRAIN_DAYS = 14     # 최소 학습 데이터 일수
WEEKDAY_KO     = ['월', '화', '수', '목', '금', '토', '일']

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

def forecast_sarima(df, periods=7):
    """SARIMA(1,1,1)(1,1,1,7) 단기 예측 — 주간 계절성 반영
    statsmodels 미설치 시 None 반환 (Prophet 폴백)
    """
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
            result = model.fit(disp=False, maxiter=200)
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


def _ensemble_val(prophet_val, sarima_val, quick_val, day_idx):
    """Prophet + SARIMA + SMA/EMA 앙상블
    단기(0~2일): SARIMA 가중  / 장기(3일+): Prophet 가중
    SARIMA 없으면: Prophet 70% + quick 30%
    """
    if sarima_val is None:
        return round(prophet_val * 0.7 + quick_val * 0.3)
    if day_idx < 3:  # 단기
        p_w, s_w, q_w = 0.30, 0.50, 0.20
    else:            # 장기
        p_w, s_w, q_w = 0.55, 0.25, 0.20
    return round(prophet_val * p_w + sarima_val * s_w + quick_val * q_w)


# ─── 예약 선행 지표 (ska-014) ─────────────────────────────────────────────────

def get_reservation_count(con, target_date_str):
    """특정 날짜의 확정 예약 건수 조회 (reservation 스키마)
    reservation 스키마 연결이 필요하므로 별도 con 필요 시 내부 처리
    """
    try:
        res_con = psycopg2.connect("dbname=jay options='-c search_path=reservation,public'")
        try:
            row = _one(res_con, """
                SELECT COUNT(*) AS cnt
                FROM reservations
                WHERE date = %s
                  AND status IN ('confirmed', 'pending', 'completed')
            """, (target_date_str,))
            return int(row[0]) if row and row[0] else 0
        finally:
            res_con.close()
    except Exception:
        return 0  # 조회 실패 시 무시


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


def save_forecast_result(con, forecast_date, result, mape=None):
    """예측 결과를 ska.forecast_results에 저장 → n8n/레베카에서 조회 가능"""
    predictions = {
        'yhat':         result['yhat'],
        'yhat_prophet': result.get('yhat_prophet', result['yhat']),
        'yhat_sarima':  result.get('yhat_sarima'),
        'yhat_quick':   result.get('yhat_quick'),
        'yhat_lower':   result['yhat_lower'],
        'yhat_upper':   result['yhat_upper'],
        'reservation_count': result.get('reservation_count', 0),
    }
    params = _load_model_params()
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


def get_recent_mape(con, days=7):
    """최근 N일 평균 MAPE 조회 (forecast_accuracy 테이블)"""
    try:
        row = _one(con, """
            SELECT AVG(mape) FROM forecast_accuracy
            WHERE target_date >= current_date - %s
              AND mape IS NOT NULL
        """, (days,))
        return round(float(row[0]), 1) if row and row[0] else None
    except Exception:
        return None


# ─── 예측 실행 ────────────────────────────────────────────────────────────────

def run_forecast(con, base_date, periods):
    """Prophet + SARIMA + SMA/EMA 앙상블 예측
    returns: list of result dicts (yhat = 앙상블 최종값)
    """
    weekday_avg = load_weekday_avg(con)
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
                'reservation_count': get_reservation_count(con, str(target_d)),
            })
        return results

    print(f'[FORECAST] 학습 데이터: {len(hist_df)}일 ({hist_df["ds"].min().date()}~{hist_df["ds"].max().date()})')

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
        yhat_final = _ensemble_val(yhat_prophet_final, yhat_sarima, yhat_quick, i)

        # ── 예약 선행 지표 ──
        res_cnt = get_reservation_count(con, d_str)

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
            'reservation_count': res_cnt,
        })

    print(f'[FORECAST] 앙상블 예측 완료: {len(results)}일')
    return results


# ─── PostgreSQL 저장 ────────────────────────────────────────────────────────────

def save_forecast(con, results):
    """forecast 테이블에 저장 (target_date 기존 예측 교체)"""
    target_dates = [str(r['date']) for r in results]
    cur = con.cursor()

    for d in target_dates:
        cur.execute("DELETE FROM forecast WHERE target_date = %s", (d,))

    for r in results:
        confidence = 0.15 if r.get('is_fallback') else _calc_confidence(r)
        cur.execute("""
            INSERT INTO forecast
              (target_date, predicted_revenue, base_forecast,
               env_score, yhat_lower, yhat_upper, confidence, model_version)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            str(r['date']),
            r['yhat'],
            r['base_forecast'],
            float(r['env_score']),
            r['yhat_lower'],
            r['yhat_upper'],
            confidence,
            MODEL_VERSION,
        ))

    cur.close()
    con.commit()
    return len(results)


def _calc_confidence(r):
    """신뢰구간 폭 기반 확신도 (0.0~1.0)"""
    if r['yhat'] <= 0:
        return 0.0
    spread = r['yhat_upper'] - r['yhat_lower']
    ratio  = spread / r['yhat']
    return max(0.0, round(1.0 - ratio / 2, 3))


# ─── 텔레그램 포맷 ────────────────────────────────────────────────────────────

def format_daily(result, base_date, recent_mape=None):
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

    lines.append('■ 보정 요인')
    lines.append(f'  요일({wd}): 주간 패턴 반영 📅')

    temp = env.get('temperature', TEMP_DEFAULT)
    rain = env.get('rain_prob', 0.0)
    if rain > 0.3:
        lines.append(f'  날씨(강수 {int(rain*100)}%  {temp:.0f}°C): 감소 요인 🌧️')
    else:
        lines.append(f'  날씨(맑음 {temp:.0f}°C): 보정 없음 ☀️')

    if res_cnt > 0:
        lines.append(f'  예약 현황: {res_cnt}건 확정 📋')
    else:
        lines.append('  예약 현황: 조회 없음')

    if env_score > 0:
        lines.append(f'  시험 기간: +{env_score}점 📚')
    elif env.get('vacation_flag'):
        lines.append('  방학 중 📚')
    else:
        lines.append('  이벤트: 없음')

    lines.append('')

    # 신뢰 구간
    lines.append('■ 신뢰 구간')
    lines.append(f'  80%: {r["yhat_lower"]:,} ~ {r["yhat_upper"]:,}원')
    lines.append(f'  확신도: {"█" * round(conf*10)}{"░" * (10-round(conf*10))} ({conf*100:.0f}%)')
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
    lines += ['', f'💰 7일 합계: ~{total:,}원', f'   일 평균: ~{total // len(results):,}원', '']
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
    return '\n'.join(lines)


# ─── 월간 모델 진단 (ska-011/013) ────────────────────────────────────────────

def _get_accuracy_history(con, days=90):
    """forecast_accuracy 최근 N일 조회"""
    try:
        rows = _qry(con, f"""
            SELECT target_date, actual_revenue, predicted_revenue,
                   error, mape, model_version
            FROM forecast_accuracy
            WHERE target_date >= current_date - INTERVAL '{int(days)} days'
            ORDER BY target_date
        """)
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
            hits = _rag.search('operations', '매출 예측 오류 MAPE 패턴', limit=3, threshold=0.6)
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
        grade = '✅ 양호' if mape <= 12 else ('🟡 주의' if mape <= 22 else '🔴 개선 필요')
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
                flag = '  ⚠️' if abs(bias) > 30000 else '  '
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

        results = run_forecast(con, base_date, periods)
        saved   = save_forecast(con, results)
        print(f'[FORECAST] ✅ {saved}건 저장 → forecast 테이블')

        # forecast_results에 저장 (n8n/레베카 연동용) — daily만
        recent_mape = get_recent_mape(con)
        if mode == 'daily' and results:
            save_forecast_result(con, results[0]['date'], results[0], mape=recent_mape)
            print(f'[FORECAST] ✅ forecast_results 저장 ({results[0]["date"]})')

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

    if mode == 'daily':
        print(format_daily(results, base_date, recent_mape=recent_mape))
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
