"""
ska-006/007/010/011/013: 포캐스트(FORECAST) — Prophet 예측 엔진 + 월간 모델 진단

모드:
  --mode=daily   : 익일 1일 예측 (기본)
  --mode=weekly  : 다음 7일 예측 (D+1 ~ D+7)
  --mode=monthly : 다음 30일 예측 (D+1 ~ D+30)
  --mode=review  : 월간 모델 진단 + LLM 분석 (ska-011)
  --date=YYYY-MM-DD : 기준 날짜 (기본: 오늘)
  --json         : JSON 출력 (텔레그램용)

모델 (prophet-v3):
  - Prophet (weekly_seasonality=True, yearly=False)
  - add_country_holidays(KR)
  - regressor: exam_score, rain_prob, vacation_flag, temperature (ska-010 추가)

ska-007 변경: exam_score = environment_factors.exam_score
             + SUM(exam_events.score_weight) — 큐넷·수능·모의고사 반영
ska-010 변경: temperature regressor 추가 (이미 eve.py가 수집 중, 기본값=15.0°C)

출력:
  텔레그램 포맷 텍스트 (stdout)
  --json: JSON

실행: bots/ska/venv/bin/python bots/ska/src/forecast.py [--mode=daily]
launchd: 매일 18:00 (ai.ska.forecast)
"""
import sys
import os
import json
import warnings
import duckdb
import pandas as pd
from datetime import date as date_type, timedelta

warnings.filterwarnings('ignore')  # Prophet Stan 경고 억제

DUCKDB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'db', 'ska.duckdb')
)

MODEL_VERSION = 'prophet-v3'
TEMP_DEFAULT  = 15.0  # 기온 기본값 (°C) — 수집 누락 시
MIN_TRAIN_DAYS = 14  # 최소 학습 데이터 일수
WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일']


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
    rows = con.execute("""
        SELECT
            r.date,
            r.actual_revenue,
            COALESCE(e.exam_score,   0) +
                COALESCE(ex.total_event_score, 0)         AS exam_score,
            COALESCE(e.rain_prob,    0.0)                 AS rain_prob,
            COALESCE(CAST(e.vacation_flag AS INTEGER), 0) AS vacation_flag,
            COALESCE(e.temperature, 15.0)                 AS temperature,
            COALESCE(CAST(e.bridge_holiday_flag AS INTEGER), 0) AS bridge_holiday
        FROM revenue_daily r
        LEFT JOIN environment_factors e ON e.date = r.date
        LEFT JOIN (
            SELECT date, SUM(score_weight) AS total_event_score
            FROM exam_events
            GROUP BY date
        ) ex ON ex.date = r.date
        ORDER BY r.date
    """).fetchall()

    df = pd.DataFrame(rows, columns=['ds', 'y', 'exam_score', 'rain_prob', 'vacation_flag', 'temperature', 'bridge_holiday'])
    df['ds'] = pd.to_datetime(df['ds'])
    df['y'] = df['y'].astype(float)
    return df


def load_weekday_avg(con):
    """요일별 평균 매출 → base_forecast 기준값"""
    rows = con.execute("""
        SELECT dayofweek(date) as dow, AVG(actual_revenue) as avg_rev
        FROM revenue_daily
        GROUP BY 1 ORDER BY 1
    """).fetchall()
    return {r[0]: round(r[1]) for r in rows}


def load_future_env(con, start_date, end_date):
    """예측 기간의 환경 요인 로드
    ska-007: environment_factors + exam_events UNION — 한쪽만 있는 날도 커버
    combined_exam = env.exam_score + SUM(exam_events.score_weight)
    """
    rows = con.execute("""
        SELECT
            d.date,
            COALESCE(e.exam_score, 0) +
                COALESCE(ex.total_event_score, 0)         AS exam_score,
            COALESCE(e.rain_prob,    0.0)                 AS rain_prob,
            COALESCE(CAST(e.vacation_flag AS INTEGER), 0) AS vacation_flag,
            COALESCE(e.temperature, 15.0)                 AS temperature,
            COALESCE(CAST(e.bridge_holiday_flag AS INTEGER), 0) AS bridge_holiday
        FROM (
            SELECT date FROM environment_factors
            WHERE date >= ? AND date <= ?
            UNION
            SELECT date FROM exam_events
            WHERE date >= ? AND date <= ?
        ) d
        LEFT JOIN environment_factors e ON e.date = d.date
        LEFT JOIN (
            SELECT date, SUM(score_weight) AS total_event_score
            FROM exam_events
            GROUP BY date
        ) ex ON ex.date = d.date
        ORDER BY d.date
    """, (str(start_date), str(end_date),
          str(start_date), str(end_date))).fetchall()

    env = {str(r[0]): {'exam_score': r[1], 'rain_prob': r[2], 'vacation_flag': r[3], 'temperature': r[4], 'bridge_holiday': r[5]}
           for r in rows}
    return env


# ─── Prophet 모델 ─────────────────────────────────────────────────────────────

def build_model():
    from prophet import Prophet
    model = Prophet(
        weekly_seasonality=True,
        yearly_seasonality=False,   # 1년 미만 데이터
        daily_seasonality=False,
        seasonality_mode='additive',
        interval_width=0.80,        # 80% 신뢰구간
        uncertainty_samples=500,
    )
    model.add_country_holidays(country_name='KR')
    model.add_regressor('exam_score')
    model.add_regressor('rain_prob')
    model.add_regressor('vacation_flag')
    model.add_regressor('temperature')    # ska-010: 기온 영향 반영
    model.add_regressor('bridge_holiday') # ska-012: 징검다리 연휴 (수요 급감)
    return model


def fill_future_regressors(future_df, env_map):
    """미래 DataFrame에 환경 요인 채우기 (없는 날 = 0)"""
    future_df = future_df.copy()
    dates = future_df['ds'].dt.strftime('%Y-%m-%d')
    future_df['exam_score']   = dates.map(lambda d: env_map.get(d, {}).get('exam_score',    0))
    future_df['rain_prob']    = dates.map(lambda d: env_map.get(d, {}).get('rain_prob',     0.0))
    future_df['vacation_flag']= dates.map(lambda d: env_map.get(d, {}).get('vacation_flag', 0))
    future_df['temperature']   = dates.map(lambda d: env_map.get(d, {}).get('temperature',   TEMP_DEFAULT))
    future_df['bridge_holiday']= dates.map(lambda d: env_map.get(d, {}).get('bridge_holiday', 0))
    return future_df


# ─── 예측 실행 ────────────────────────────────────────────────────────────────

def run_forecast(con, base_date, periods):
    weekday_avg = load_weekday_avg(con)

    """
    Prophet 학습 → N일 예측
    returns: list of (target_date, yhat, base_forecast, env_score, yhat_lower, yhat_upper)
    """
    hist_df = load_history(con)
    if len(hist_df) < MIN_TRAIN_DAYS:
        raise ValueError(f'학습 데이터 부족: {len(hist_df)}일 (최소 {MIN_TRAIN_DAYS}일 필요)')

    print(f'[FORECAST] 학습 데이터: {len(hist_df)}일 ({hist_df["ds"].min().date()}~{hist_df["ds"].max().date()})')

    # 모델 학습 (Prophet stderr 억제)
    model = build_model()
    with open(os.devnull, 'w') as devnull:
        old_stderr = sys.stderr
        sys.stderr = devnull
        try:
            model.fit(hist_df)
        finally:
            sys.stderr = old_stderr

    print(f'[FORECAST] 모델 학습 완료')

    # 미래 DataFrame — 훈련 마지막 날짜 기준으로 필요한 만큼 확장
    predict_start = base_date + timedelta(days=1)
    predict_end   = base_date + timedelta(days=periods)
    hist_last = hist_df['ds'].max().date()
    needed = max(periods, (predict_end - hist_last).days)
    future = model.make_future_dataframe(periods=needed, freq='D')
    env_map = load_future_env(con, predict_start, predict_end)
    # 학습 기간 환경 요인도 포함 (future에 과거 포함되므로)
    hist_env_map = {}
    for _, row in hist_df.iterrows():
        d = row['ds'].strftime('%Y-%m-%d')
        hist_env_map[d] = {
            'exam_score':    row['exam_score'],
            'rain_prob':     row['rain_prob'],
            'vacation_flag': row['vacation_flag'],
            'temperature':   row['temperature'],
            'bridge_holiday': row['bridge_holiday'],
        }
    combined_env = {**hist_env_map, **env_map}

    future = fill_future_regressors(future, combined_env)

    # 예측
    forecast = model.predict(future)

    # 예측 대상 날짜만 필터 (D+1 ~ D+periods)
    start_ts = pd.Timestamp(predict_start)
    end_ts   = pd.Timestamp(predict_end)
    filt = forecast[(forecast['ds'] >= start_ts) & (forecast['ds'] <= end_ts)].copy()

    results = []
    for _, row in filt.iterrows():
        target_d = row['ds'].date()
        d_str    = str(target_d)
        env_info = env_map.get(d_str, {})
        # base_forecast: 해당 요일의 히스토리 평균 (regressor 영향 제외한 기준선)
        # dayofweek: Python weekday() 0=월 ... 6=일, DuckDB dayofweek 0=일 ... 6=토
        # → 통일: 요일 키를 Python weekday()로 사용 (0=월...6=일)
        # weekday_avg 키는 DuckDB dayofweek (0=일..6=토)
        # target_d.weekday(): 0=월..6=일 → DuckDB: (weekday+1)%7
        duck_dow = (target_d.weekday() + 1) % 7
        base = weekday_avg.get(duck_dow, round(row['yhat']))
        yhat_raw   = round(row['yhat'])
        yhat_upper = max(0, round(row['yhat_upper']))
        yhat_lower = max(0, round(row['yhat_lower']))
        # 공휴일/이상값 과보정: Prophet이 음수를 예측하는 경우 CI 상한 기반 보수적 추정
        # (삼일절·대체공휴일 등 holiday coefficient 과대 반영 방지)
        if yhat_raw <= 0 and yhat_upper > 0:
            yhat_final  = round(yhat_upper * 0.5)
            is_fallback = True
        else:
            yhat_final  = max(0, yhat_raw)
            is_fallback = False
        results.append({
            'date':           target_d,
            'yhat':           yhat_final,
            'base_forecast':  max(0, base),
            'env_score':      env_info.get('exam_score', 0),
            'yhat_lower':     yhat_lower,
            'yhat_upper':     yhat_upper,
            'is_fallback':    is_fallback,
        })

    print(f'[FORECAST] 예측 완료: {len(results)}일')
    return results


# ─── DuckDB 저장 ──────────────────────────────────────────────────────────────

def save_forecast(con, results):
    """forecast 테이블에 저장 (target_date 기존 예측 교체)"""
    target_dates = [str(r['date']) for r in results]

    # 같은 날짜 모든 버전 기존 예측 삭제 (구버전 누적 방지)
    for d in target_dates:
        con.execute("DELETE FROM forecast WHERE target_date = ?", (d,))

    for r in results:
        next_id = con.execute("SELECT nextval('forecast_id_seq')").fetchone()[0]
        # 폴백 사용 시 확신도 고정 0.15 (CI 기반 보수적 추정 — 신뢰도 낮음)
        confidence = 0.15 if r.get('is_fallback') else _calc_confidence(r)
        con.execute("""
            INSERT INTO forecast
              (id, target_date, predicted_revenue, base_forecast,
               env_score, yhat_lower, yhat_upper, confidence, model_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            next_id,
            str(r['date']),
            r['yhat'],
            r['base_forecast'],
            float(r['env_score']),
            r['yhat_lower'],
            r['yhat_upper'],
            confidence,
            MODEL_VERSION,
        ))

    return len(results)


def _calc_confidence(r):
    """신뢰구간 폭 기반 확신도 (0.0~1.0, 높을수록 좁은 구간)"""
    if r['yhat'] <= 0:
        return 0.0
    spread = r['yhat_upper'] - r['yhat_lower']
    ratio  = spread / r['yhat']
    # ratio 0 → 1.0, ratio 2 → 0.0
    return max(0.0, round(1.0 - ratio / 2, 3))


# ─── 텔레그램 포맷 ────────────────────────────────────────────────────────────

def format_daily(result, base_date):
    """익일 단일 예측 포맷"""
    r    = result[0]
    d    = r['date']
    wd   = WEEKDAY_KO[d.weekday()]
    conf = r.get('confidence', _calc_confidence(r))

    lines = [
        f'📊 포캐스트 익일 예측 리포트',
        f'{"─" * 15}',
        f'📅 {d.month}/{d.day}({wd}) 예상 매출',
        '',
        f'💰 예측: {r["yhat"]:,}원',
        f'   범위: {r["yhat_lower"]:,}원 ~ {r["yhat_upper"]:,}원',
        f'   확신: {"█" * round(conf * 10)}{"░" * (10 - round(conf * 10))}  ({conf * 100:.0f}%)',
        '',
    ]

    env_parts = []
    if r['env_score'] > 0:
        env_parts.append(f'📚 시험 기간 (점수 +{r["env_score"]})')
    elif r['env_score'] < 0:
        env_parts.append(f'📚 방학 중 (점수 {r["env_score"]})')
    if env_parts:
        lines.append('🌍 환경 요인:')
        for p in env_parts:
            lines.append(f'   {p}')
        lines.append('')

    return '\n'.join(lines)


def format_weekly(results, base_date):
    """주간 예측 포맷"""
    lines = [
        f'📊 포캐스트 주간 예측 리포트',
        f'{"─" * 15}',
        f'📅 향후 7일 예상 매출',
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
        f'📊 포캐스트 월간 예측 리포트',
        f'{"─" * 15}',
        f'📅 향후 30일 예상 매출',
        '',
        f'💰 예측 합계: ~{total:,}원',
        f'   범위: {low:,}원 ~ {high:,}원',
        f'   일 평균: ~{avg:,}원',
        '',
    ]
    # 주별 소계
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
    """forecast_accuracy 최근 N일 조회 — 편향·MAPE 추이용"""
    try:
        rows = con.execute("""
            SELECT target_date, actual_revenue, predicted_revenue,
                   error, mape, model_version
            FROM forecast_accuracy
            WHERE target_date >= current_date - INTERVAL (?) DAY
            ORDER BY target_date
        """, (days,)).fetchall()
        return [{'date': str(r[0]), 'actual': r[1], 'predicted': r[2],
                 'error': r[3], 'mape': r[4], 'model': r[5]}
                for r in rows]
    except Exception:
        return []


def _calc_weekday_bias(accuracy_list):
    """요일별 평균 오차 계산 (error = actual - predicted, 양수=과소예측)"""
    from collections import defaultdict
    buckets = defaultdict(list)
    for a in accuracy_list:
        if a['error'] is not None:
            wd = date_type.fromisoformat(a['date']).weekday()  # 0=월
            buckets[wd].append(a['error'])
    return {wd: round(sum(v) / len(v)) for wd, v in buckets.items()}


def _run_cross_validation(hist_df):
    """Prophet 교차검증 — 데이터 부족 시 None 반환"""
    try:
        from prophet.diagnostics import cross_validation, performance_metrics
        model = build_model()
        import sys, os
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


def _call_llm_diagnosis(cv_metrics, accuracy_list, weekday_bias):
    """OpenAI GPT-4o로 모델 진단 요청
    - temperature=0.1: 분석용 낮은 온도 → 일관된 진단
    """
    import os
    try:
        from openai import OpenAI
        import openai
    except ImportError:
        return '(openai 패키지 미설치)'

    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return '(OPENAI_API_KEY 미설정)'

    # ── 시스템 프롬프트 ──
    SYSTEM_PROMPT = (
        "당신은 스터디카페 매출 예측 모델(Prophet) 전문 진단 AI입니다. "
        "성능 지표 데이터를 분석하여 한국어로 간결하고 실용적인 개선 방안을 제시합니다."
    )

    # ── 동적 컨텍스트 구성 ──
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

    user_content = f"""Prophet 매출 예측 모델 월간 성능 평가 데이터입니다.

[교차검증 결과]
{cv_text}

[요일별 예측 편향 (error = 실제 - 예측, 최근 90일)]
{bias_text}

[최근 추이]
{mape_trend}

현재 모델: prophet-v3
  - seasonality_mode: additive
  - regressors: exam_score, rain_prob, vacation_flag, temperature
  - weekly_seasonality: True, yearly_seasonality: False

다음을 한국어로 간결하게 답해줘 (최대 6줄):
1. 모델 성능 평가 (어느 요일/구간이 취약한지)
2. 핵심 원인 추정
3. 파라미터 조정 권고 (seasonality_mode, changepoint_prior_scale 등 구체적으로)
4. prophet-v4 업그레이드 시점 권고"""

    try:
        client = OpenAI(api_key=api_key)
        resp = client.chat.completions.create(
            model='gpt-4o',
            max_tokens=500,
            temperature=0.1,   # 분석용 — 낮은 온도로 일관된 진단
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


def format_monthly_review(base_date, cv_metrics, weekday_bias, accuracy_list, llm_diagnosis):
    """월간 모델 진단 텔레그램 포맷"""
    wd_names = ['월', '화', '수', '목', '금', '토', '일']
    m, y = base_date.month, base_date.year

    lines = [
        f'🔬 포캐스트 월간 모델 진단',
        f'{"─" * 15}',
        f'📅 {y}년 {m}월 리뷰  (모델: {MODEL_VERSION})',
        '',
    ]

    # ── 교차검증 ──
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

    # ── 요일별 편향 ──
    if weekday_bias:
        lines.append('📉 요일별 예측 편향')
        for wd in range(7):
            if wd in weekday_bias:
                bias = weekday_bias[wd]
                flag = '  ⚠️' if abs(bias) > 30000 else '  '
                direction = '과소' if bias > 0 else '과대'
                lines.append(f'  {flag}{wd_names[wd]}: {bias:+,}원 ({direction}예측)')
        lines.append('')

    # ── LLM 진단 ──
    lines += [
        f'🤖 AI 진단',
        f'{"─" * 15}',
    ]
    for line in llm_diagnosis.split('\n'):
        lines.append(f'  {line}' if line.strip() else '')
    lines.append('')

    return '\n'.join(lines)


def run_monthly_review(base_date_str=None):
    """월간 모델 진단 실행 (ska-011)"""
    base_date = date_type.fromisoformat(base_date_str) if base_date_str else date_type.today()
    print(f'[REVIEW] 월간 모델 진단 시작: {base_date}')

    con = duckdb.connect(DUCKDB_PATH)
    try:
        hist_df = load_history(con)
        accuracy_list = _get_accuracy_history(con, days=90)
    finally:
        con.close()

    print(f'[REVIEW] 학습 데이터: {len(hist_df)}일 / 정확도 기록: {len(accuracy_list)}건')

    # 교차검증
    cv_metrics = None
    if len(hist_df) >= 75:
        print('[REVIEW] 교차검증 실행 중...')
        cv_metrics = _run_cross_validation(hist_df)
        if cv_metrics:
            print(f'[REVIEW] CV 완료: MAPE={cv_metrics["mape"]:.1f}% RMSE={cv_metrics["rmse"]:,}')
    else:
        print(f'[REVIEW] ⚠️ 교차검증 스킵: 데이터 {len(hist_df)}일 < 75일')

    # 요일별 편향
    weekday_bias = _calc_weekday_bias(accuracy_list)

    # LLM 진단
    print('[REVIEW] LLM 모델 진단 요청 중...')
    llm_diagnosis = _call_llm_diagnosis(cv_metrics, accuracy_list, weekday_bias)
    print(f'[REVIEW] LLM 응답 완료')

    # 포맷 + 출력
    report = format_monthly_review(base_date, cv_metrics, weekday_bias, accuracy_list, llm_diagnosis)
    print(report)
    return report


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run(mode='daily', base_date_str=None, output_json=False):
    base_date = date_type.fromisoformat(base_date_str) if base_date_str \
                else date_type.today()

    mode_periods = {'daily': 1, 'weekly': 7, 'monthly': 30}
    periods = mode_periods.get(mode, 1)

    print(f'[FORECAST] 기준: {base_date}  모드: {mode}  기간: {periods}일')

    con = duckdb.connect(DUCKDB_PATH)

    try:
        results = run_forecast(con, base_date, periods)
        saved   = save_forecast(con, results)
        print(f'[FORECAST] ✅ {saved}건 저장 → forecast 테이블')
    except ValueError as e:
        print(f'[FORECAST] ❌ {e}')
        con.close()
        return None
    finally:
        con.close()

    # 결과에 confidence 추가
    for r in results:
        r['confidence'] = 0.15 if r.get('is_fallback') else _calc_confidence(r)

    if output_json:
        out = [
            {**r, 'date': str(r['date'])}
            for r in results
        ]
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return results

    # 텔레그램 포맷 출력
    if mode == 'daily':
        print(format_daily(results, base_date))
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
