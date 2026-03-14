"""
ska-004/009: 레베카(REBECCA) — 일간·주간 현황 리포트

분석 항목 (--mode=daily, 기본):
  - 최신 영업일 매출·가동률·예약 현황
  - 전일·전주 같은 요일·7일 평균 대비 비교
  - 이번달 집계 + 마감 예측
  - 이상 감지 (매출 급감·무매출 영업일 등)
  - 내일 환경 요인 (공휴일·날씨·방학)

분석 항목 (--mode=weekly, ska-009):
  - 전주 매출 집계
  - 전주 예측 정확도 (MAPE) — forecast_results + revenue_daily
  - 이번 주 주요 이벤트 예고

출력:
  기본: 텔레그램용 포맷 텍스트 (stdout)
  --json: JSON 출력 (스카 연동용)

실행: bots/ska/venv/bin/python bots/ska/src/rebecca.py [--mode=daily|weekly] [--date=YYYY-MM-DD] [--json]
launchd:
  매일    08:00 ai.ska.rebecca (daily)
  매주 월 08:05 ai.ska.rebecca-weekly (weekly)
"""
import sys
import os
import json
import psycopg2
from datetime import date as date_type, timedelta

# RAG 클라이언트 (실패해도 리포트 기능에 영향 없음)
try:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))
    from bots.ska.lib.rag_client import RagClient as _RagClient
    _rag = _RagClient()
except Exception:
    _rag = None

PG_SKA = "dbname=jay options='-c search_path=ska,public'"
PG_RES = "dbname=jay options='-c search_path=reservation,public'"

WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일']


# ─── psycopg2 헬퍼 ──────────────────────────────────────────────────────────────

def _qry(con, sql, params=()):
    cur = con.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def _one(con, sql, params=()):
    cur = con.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    cur.close()
    return row


# ─── 인자 파싱 ─────────────────────────────────────────────────────────────────

def parse_args():
    target_date = None
    output_json = False
    mode = 'daily'
    for arg in sys.argv[1:]:
        if arg.startswith('--date='):
            target_date = arg.split('=', 1)[1]
        elif arg == '--json':
            output_json = True
        elif arg.startswith('--mode='):
            mode = arg.split('=', 1)[1]
    return target_date, output_json, mode


# ─── 데이터 조회 ───────────────────────────────────────────────────────────────

def get_latest_date(con):
    """DB에서 매출 데이터가 있는 최신 날짜"""
    row = _one(con, "SELECT MAX(date) FROM revenue_daily WHERE actual_revenue > 0")
    return str(row[0]) if row and row[0] else None


def get_day(con, date_str):
    """특정 날짜의 revenue_daily 행"""
    row = _one(con, """
        SELECT date, actual_revenue, occupancy_rate, total_reservations,
               cancellation_count, studyroom_revenue, general_revenue
        FROM revenue_daily WHERE date = %s
    """, (date_str,))
    if not row:
        return None
    return {
        'date':               str(row[0]),
        'revenue':            row[1] or 0,
        'occupancy_rate':     row[2] or 0.0,
        'total_reservations': row[3] or 0,
        'cancellation_count': row[4] or 0,
        'studyroom_revenue':  row[5] or 0,
        'general_revenue':    row[6] or 0,
    }


def get_avg_7d(con, date_str):
    """date_str 이전 7일간 평균 매출·가동률 (해당 날짜 제외)"""
    row = _one(con, """
        SELECT AVG(actual_revenue), AVG(occupancy_rate), COUNT(*)
        FROM revenue_daily
        WHERE date >= %s AND date < %s
    """, (
        str(date_type.fromisoformat(date_str) - timedelta(days=7)),
        date_str
    ))
    return {
        'avg_revenue':    round(row[0] or 0),
        'avg_occupancy':  row[1] or 0.0,
        'days_count':     row[2] or 0,
    }


def get_monthly(con, date_str):
    """해당 월 집계"""
    ym = date_str[:7]  # 'YYYY-MM'
    row = _one(con, """
        SELECT COUNT(*) as days,
               SUM(actual_revenue) as total,
               AVG(actual_revenue) as daily_avg,
               SUM(total_reservations) as total_res,
               MAX(actual_revenue) as peak,
               MIN(CASE WHEN actual_revenue > 0 THEN actual_revenue END) as trough
        FROM revenue_daily
        WHERE TO_CHAR(date, 'YYYY-MM') = %s AND date <= %s
    """, (ym, date_str))

    d = date_type.fromisoformat(date_str)
    import calendar
    days_in_month = calendar.monthrange(d.year, d.month)[1]
    elapsed = d.day
    daily_avg = row[2] or 0
    projected = round(daily_avg * days_in_month) if daily_avg else 0

    return {
        'ym':          ym,
        'days':        row[0] or 0,
        'total':       row[1] or 0,
        'daily_avg':   round(row[2] or 0),
        'total_res':   row[3] or 0,
        'peak':        row[4] or 0,
        'trough':      row[5] or 0,
        'days_in_month': days_in_month,
        'elapsed':     elapsed,
        'projected':   projected,
    }


def get_env(con, date_str):
    """특정 날짜 환경 요인"""
    row = _one(con, """
        SELECT holiday_flag, holiday_name, rain_prob, temperature,
               exam_score, vacation_flag, festival_flag, festival_name
        FROM environment_factors WHERE date = %s
    """, (date_str,))
    if not row:
        return None
    return {
        'holiday_flag':  bool(row[0]),
        'holiday_name':  row[1],
        'rain_prob':     row[2] or 0.0,
        'temperature':   row[3],
        'exam_score':    row[4] or 0,
        'vacation_flag': bool(row[5]),
        'festival_flag': bool(row[6]),
        'festival_name': row[7],
    }


def get_recent_bars(con, date_str, n=7):
    """최근 n일 매출 바 차트용 데이터"""
    rows = _qry(con, """
        SELECT date, actual_revenue, occupancy_rate
        FROM revenue_daily
        WHERE date <= %s
        ORDER BY date DESC LIMIT %s
    """, (date_str, n))
    return [{'date': str(r[0]), 'revenue': r[1] or 0, 'occ': r[2] or 0.0}
            for r in reversed(rows)]


# ─── 이상 감지 ─────────────────────────────────────────────────────────────────

def detect_anomalies(today, avg_7d, env_today):
    anomalies = []
    rev = today['revenue']
    avg = avg_7d['avg_revenue']

    is_holiday = env_today and env_today['holiday_flag']
    is_vacation = env_today and env_today['vacation_flag']
    if rev == 0 and not is_holiday and not is_vacation:
        anomalies.append('⚠️ 매출 0원 (비공휴일·비방학)')

    if avg > 0 and rev < avg * 0.4 and rev > 0:
        # 표준 형식: 핵심 수치 먼저, ─ 구분
        anomalies.append(f'⚠️ 매출 급감 ─ 7일 평균 대비 {rev/avg*100:.0f}% (평균 {avg:,}원)')

    if avg > 0 and rev > avg * 2.5:
        anomalies.append(f'📈 매출 급등 ─ 7일 평균 대비 +{rev/avg*100-100:.0f}% (평균 {avg:,}원)')

    return anomalies


def get_yesterday_forecast(con, date_str):
    """어제 forecast.py가 예측한 오늘 매출 조회 (ska.forecast_results)
    forecast_date = 예측 대상 날짜 (오늘 = date_str)
    """
    try:
        row = _one(con, """
            SELECT predictions->>'yhat' AS predicted
            FROM ska.forecast_results
            WHERE forecast_date = %s
            ORDER BY created_at DESC LIMIT 1
        """, (date_str,))
        return float(row[0]) if row and row[0] else None
    except Exception:
        return None


def get_forecast_context(con, date_str):
    """특정 날짜 최신 forecast_results의 설명용 컨텍스트 조회"""
    try:
        row = _one(con, """
            SELECT predictions
            FROM ska.forecast_results
            WHERE forecast_date = %s
            ORDER BY created_at DESC LIMIT 1
        """, (date_str,))
        if not row or not row[0]:
            return None

        payload = row[0]
        if isinstance(payload, str):
            payload = json.loads(payload)
        if not isinstance(payload, dict):
            return None

        room_counts = payload.get('reservation_room_counts') or {}
        if isinstance(room_counts, str):
            try:
                room_counts = json.loads(room_counts)
            except Exception:
                room_counts = {}

        return {
            'yhat': int(payload.get('yhat') or 0),
            'yhat_lower': int(payload.get('yhat_lower') or 0),
            'yhat_upper': int(payload.get('yhat_upper') or 0),
            'confidence': float(payload.get('confidence') or 0.0),
            'reservation_count': int(payload.get('reservation_count') or 0),
            'reservation_booked_hours': float(payload.get('reservation_booked_hours') or 0.0),
            'reservation_density': float(payload.get('reservation_density') or 0.0),
            'reservation_unique_rooms': int(payload.get('reservation_unique_rooms') or 0),
            'reservation_peak_overlap': int(payload.get('reservation_peak_overlap') or 0),
            'reservation_avg_duration_hours': float(payload.get('reservation_avg_duration_hours') or 0.0),
            'reservation_room_counts': room_counts if isinstance(room_counts, dict) else {},
            'reservation_morning_count': int(payload.get('reservation_morning_count') or 0),
            'reservation_afternoon_count': int(payload.get('reservation_afternoon_count') or 0),
            'reservation_evening_count': int(payload.get('reservation_evening_count') or 0),
            'calibration_adjustment': int(payload.get('calibration_adjustment') or 0),
            'calibration_notes': payload.get('calibration_notes') or [],
            'env_info': payload.get('env_info') or {},
        }
    except Exception:
        return None


# ─── 텔레그램 포맷 ─────────────────────────────────────────────────────────────

def pct_str(new, base):
    """증감률 문자열 ±N% (±N,000원)"""
    if not base or base == 0:
        return '—'
    delta = new - base
    pct = delta / base * 100
    sign = '+' if delta >= 0 else ''
    return f'{sign}{pct:.1f}% ({sign}{delta:,}원)'


def revenue_bar(rev, max_rev, width=10):
    """텍스트 바 차트 (매출 크기 시각화)"""
    if max_rev == 0:
        filled = 0
    else:
        filled = round(rev / max_rev * width)
    return '█' * filled + '░' * (width - filled)


def format_telegram(report):
    d   = report['today']
    avg = report['avg_7d']
    mon = report['monthly']
    env_today = report.get('env_today')
    env_tomorrow = report.get('env_tomorrow')
    tomorrow_forecast = report.get('tomorrow_forecast')
    bars  = report['recent_bars']
    anomalies = report['anomalies']

    target_date = date_type.fromisoformat(d['date'])
    wd = WEEKDAY_KO[target_date.weekday()]
    m, day = target_date.month, target_date.day

    prev_day = report.get('prev_day')
    prev_week = report.get('prev_week')
    prev_forecast = report.get('prev_forecast')  # 어제 예측값

    lines = [
        f'📊 레베카 일간 현황 리포트',
        f'{"─"*15}',
        f'📅 {m}월 {day}일 ({wd})',
        '',
    ]

    lines.append(f'💰 매출: {d["revenue"]:,}원')
    if prev_day:
        prev_wd = WEEKDAY_KO[date_type.fromisoformat(prev_day['date']).weekday()]
        lines.append(f'   ↕ 전일({prev_wd}):    {pct_str(d["revenue"], prev_day["revenue"])}')
    if prev_week:
        lines.append(f'   ↕ 전주({wd}):    {pct_str(d["revenue"], prev_week["revenue"])}')
    if avg['avg_revenue'] > 0:
        lines.append(f'   ↕ 7일 평균:    {pct_str(d["revenue"], avg["avg_revenue"])}  (평균 {avg["avg_revenue"]:,}원)')
    lines.append('')

    # 어제 예측 정확도 (ska-014: forecast_results 연동)
    if prev_forecast and d['revenue'] > 0:
        mape = abs(prev_forecast - d['revenue']) / d['revenue'] * 100
        flag = '✅' if mape < 10 else ('🟡' if mape < 20 else '🔴')
        lines.append('🎯 어제 예측 정확도')
        lines.append(f'   예측: {int(prev_forecast):,}원 → 실제: {d["revenue"]:,}원')
        lines.append(f'   MAPE: {mape:.1f}% {flag}')
        lines.append('')

    occ_pct = d['occupancy_rate'] * 100
    booked_h = d['occupancy_rate'] * 39
    lines.append(f'🏠 가동률: {occ_pct:.1f}%  ({booked_h:.1f}h / 39h)')
    lines.append(f'📋 예약: {d["total_reservations"]}건')

    st_rev = d['studyroom_revenue']
    ge_rev = d['general_revenue']
    if st_rev + ge_rev > 0:
        lines.append(f'   스터디룸 {st_rev:,}원  /  일반이용 {ge_rev:,}원')
    lines.append('')

    if bars:
        max_rev = max(b['revenue'] for b in bars) or 1
        lines.append('📉 최근 7일 매출')
        for b in bars:
            bd = date_type.fromisoformat(b['date'])
            bwd = WEEKDAY_KO[bd.weekday()]
            bar = revenue_bar(b['revenue'], max_rev)
            marker = '◀' if b['date'] == d['date'] else ' '
            lines.append(f'  {bd.month}/{bd.day}({bwd}) {bar} {b["revenue"]:,}원{marker}')
    lines.append('')

    elapsed = mon['elapsed']
    lines.append(f'📅 {mon["ym"][5:7]}월 현황 ({elapsed}일 경과 / {mon["days_in_month"]}일)')
    lines.append(f'   월 매출:  {mon["total"]:,}원')
    lines.append(f'   일 평균:  {mon["daily_avg"]:,}원')
    lines.append(f'   예상 마감: ~{mon["projected"]:,}원')
    lines.append('')

    if anomalies:
        for a in anomalies:
            lines.append(a)
    else:
        lines.append('✅ 이상 없음')
    lines.append('')

    tomorrow = target_date + timedelta(days=1)
    tmr_wd = WEEKDAY_KO[tomorrow.weekday()]
    lines.append(f'🌤️ 내일 환경 ({tomorrow.month}/{tomorrow.day} {tmr_wd})')
    if env_tomorrow:
        parts = []
        if env_tomorrow['holiday_flag']:
            parts.append(f'🎌 {env_tomorrow["holiday_name"]}')
        if env_tomorrow['temperature'] is not None:
            parts.append(f'🌡️ {env_tomorrow["temperature"]:.1f}°C')
        rp = env_tomorrow['rain_prob']
        if rp > 0:
            parts.append(f'🌧️ 강수 {int(rp*100)}%')
        if env_tomorrow['vacation_flag']:
            parts.append('📚 방학 중')
        elif env_tomorrow['exam_score'] > 0:
            parts.append(f'📚 시험 점수 +{env_tomorrow["exam_score"]}')
        if env_tomorrow['festival_flag']:
            parts.append(f'🎪 {env_tomorrow["festival_name"]}')
        lines.append('   ' + ('  '.join(parts) if parts else '데이터 없음'))
    else:
        lines.append('   데이터 없음 (이브 미수집)')

    if tomorrow_forecast:
        tf = tomorrow_forecast
        conf_pct = round((tf.get('confidence') or 0.0) * 100)
        room_counts = tf.get('reservation_room_counts') or {}
        room_bits = [
            f'A1 {room_counts.get("A1", 0)}',
            f'A2 {room_counts.get("A2", 0)}',
            f'B {room_counts.get("B", 0)}',
        ]
        lines.append('')
        lines.append('🔮 내일 예측')
        lines.append(f'   예상 매출: {tf["yhat"]:,}원  ({tf["yhat_lower"]:,}~{tf["yhat_upper"]:,}원)')
        lines.append(
            f'   예약 기준: {tf["reservation_count"]}건 / {tf["reservation_booked_hours"]:.1f}h'
            f' / 밀도 {tf["reservation_density"]*100:.0f}% / 확신도 {conf_pct}%'
        )
        if tf['reservation_unique_rooms'] > 0 or tf['reservation_peak_overlap'] > 0:
            lines.append(
                f'   구조: {tf["reservation_unique_rooms"]}룸 / 피크겹침 {tf["reservation_peak_overlap"]}건'
                f' / 평균 {tf["reservation_avg_duration_hours"]:.1f}h'
            )
        if any(room_counts.values()):
            lines.append(f'   룸 분포: {" / ".join(room_bits)}')
        if tf['reservation_morning_count'] or tf['reservation_afternoon_count'] or tf['reservation_evening_count']:
            lines.append(
                f'   시간대: 오전 {tf["reservation_morning_count"]} /'
                f' 오후 {tf["reservation_afternoon_count"]} / 저녁 {tf["reservation_evening_count"]}'
            )
        if tf['calibration_adjustment']:
            note_suffix = f' ({", ".join(tf["calibration_notes"])})' if tf['calibration_notes'] else ''
            lines.append(f'   최근 오차/예약 보정: {tf["calibration_adjustment"]:+,}원{note_suffix}')

    return '\n'.join(lines)


# ─── 주간 회고 (ska-009) ──────────────────────────────────────────────────────

def get_week_summary(con, week_start, week_end):
    """전주 매출 집계"""
    row = _one(con, """
        SELECT SUM(actual_revenue), AVG(actual_revenue),
               SUM(total_reservations), COUNT(*)
        FROM revenue_daily
        WHERE date >= %s AND date <= %s
    """, (str(week_start), str(week_end)))
    return {
        'total':        row[0] or 0,
        'avg':          round(row[1] or 0),
        'reservations': row[2] or 0,
        'days':         row[3] or 0,
    }


def get_weekly_accuracy(con, week_start, week_end):
    """전주 예측 정확도 조회 (forecast_results + revenue_daily 기준)"""
    try:
        rows = _qry(con, """
            WITH latest AS (
                SELECT DISTINCT ON (fr.forecast_date)
                    fr.forecast_date,
                    fr.model_version,
                    fr.predictions
                FROM ska.forecast_results fr
                WHERE fr.forecast_date >= %s AND fr.forecast_date <= %s
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
        """, (str(week_start), str(week_end)))
        return [{'date': str(r[0]), 'actual': r[1], 'predicted': r[2],
                 'error': r[3], 'mape': r[4], 'model_version': r[5]}
                for r in rows]
    except Exception:
        return []


def get_weekly_forecast_mape(con, week_start, week_end):
    """forecast_results + revenue_daily 기준 주간 일별 실제 MAPE 조회"""
    try:
        rows = _qry(con, """
            WITH latest AS (
                SELECT DISTINCT ON (fr.forecast_date)
                    fr.forecast_date,
                    fr.predictions
                FROM ska.forecast_results fr
                WHERE fr.forecast_date >= %s AND fr.forecast_date <= %s
                ORDER BY fr.forecast_date, fr.created_at DESC
            )
            SELECT
                latest.forecast_date,
                ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / NULLIF(rd.actual_revenue, 0)) * 100 AS mape
            FROM latest
            JOIN revenue_daily rd ON rd.date = latest.forecast_date
            WHERE rd.actual_revenue > 0
            ORDER BY latest.forecast_date
        """, (str(week_start), str(week_end)))
        return [{'date': str(r[0]), 'mape': float(r[1])} for r in rows]
    except Exception:
        return []


def get_next_week_events(con, next_start, next_end):
    """이번 주 주요 시험 이벤트"""
    try:
        rows = _qry(con, """
            SELECT date, exam_name, score_weight
            FROM exam_events
            WHERE date >= %s AND date <= %s
            ORDER BY date
        """, (str(next_start), str(next_end)))
        return [{'date': str(r[0]), 'name': r[1], 'score': r[2]} for r in rows]
    except Exception:
        return []


def get_weekly_kpi(week_start, week_end):
    """PostgreSQL reservation 스키마에서 재방문율·자동등록 성공률 집계"""
    try:
        con = psycopg2.connect(PG_RES)
        w_start = str(week_start)
        w_end   = str(week_end)

        rows = _qry(con, """
            SELECT phone
            FROM reservations
            WHERE date >= %s AND date <= %s
              AND status = 'completed'
              AND seen_only = 0
        """, (w_start, w_end))
        week_phones = [r[0] for r in rows]
        total_completed = len(week_phones)

        revisit_count = 0
        for phone in set(week_phones):
            prev = _one(con, """
                SELECT COUNT(*) FROM reservations
                WHERE phone = %s
                  AND status = 'completed'
                  AND seen_only = 0
                  AND date < %s
            """, (phone, w_start))[0]
            if prev > 0:
                revisit_count += 1

        unique_visitors = len(set(week_phones))
        revisit_rate = round(revisit_count / unique_visitors * 100) if unique_visitors > 0 else 0

        failed = _one(con, """
            SELECT COUNT(*) FROM reservations
            WHERE date >= %s AND date <= %s
              AND status = 'failed'
              AND seen_only = 0
        """, (w_start, w_end))[0]

        total_processed = total_completed + failed
        success_rate = round(total_completed / total_processed * 100) if total_processed > 0 else 100

        con.close()
        return {
            'total_completed':  total_completed,
            'unique_visitors':  unique_visitors,
            'revisit_count':    revisit_count,
            'revisit_rate':     revisit_rate,
            'failed':           failed,
            'success_rate':     success_rate,
        }
    except Exception:
        return {
            'total_completed': 0, 'unique_visitors': 0,
            'revisit_count': 0, 'revisit_rate': 0,
            'failed': 0, 'success_rate': 0,
        }


def format_weekly_review(report):
    """주간 회고 리포트 텔레그램 포맷"""
    w_start = date_type.fromisoformat(report['week_start'])
    w_end   = date_type.fromisoformat(report['week_end'])
    summary = report['summary']
    accuracy_list = report['accuracy']
    next_events   = report['next_events']

    lines = [
        f'📊 레베카 주간 회고 리포트',
        f'{"─" * 15}',
        f'📅 {w_start.month}/{w_start.day}(월) ~ {w_end.month}/{w_end.day}(일)',
        '',
    ]

    lines.append(f'💰 주간 매출: {summary["total"]:,}원')
    lines.append(f'   일 평균:  {summary["avg"]:,}원 ({summary["days"]}영업일)')
    lines.append(f'   총 예약:  {summary["reservations"]}건')
    lines.append('')

    # 📊 이번 주 예측 정확도 (작업 7-2: 컴팩트 MAPE 블록)
    lines.append('📊 이번 주 예측 정확도')
    if accuracy_list:
        valid = [a for a in accuracy_list if a['mape'] is not None]

        # 일별 MAPE 한줄 요약
        mape_parts = []
        for a in accuracy_list:
            d  = date_type.fromisoformat(a['date'])
            wd = WEEKDAY_KO[d.weekday()]
            if a['mape'] is not None:
                m    = a['mape']
                flag = '✅' if m < 10 else ('🟡' if m < 20 else '🔴')
                mape_parts.append(f'{wd} {m:.1f}%{flag}')
            else:
                mape_parts.append(f'{wd} N/A')
        if mape_parts:
            lines.append('   일별 MAPE: ' + ' / '.join(mape_parts))

        # 주간 평균 MAPE
        if valid:
            avg_mape = sum(a['mape'] for a in valid) / len(valid)
            grade = ('✅ 양호' if avg_mape <= 10
                     else ('🟡 주의' if avg_mape <= 20
                           else '🔴 모델 검토 필요'))
            lines.append(f'   주간 평균 MAPE: {avg_mape:.1f}% {grade}')

    elif report.get('forecast_mape'):
        mape_parts = []
        for item in report['forecast_mape']:
            d  = date_type.fromisoformat(item['date'])
            wd = WEEKDAY_KO[d.weekday()]
            m  = item['mape']
            flag = '✅' if m < 10 else ('🟡' if m < 20 else '🔴')
            mape_parts.append(f'{wd} {m:.1f}%{flag}')
        if mape_parts:
            lines.append('   일별 MAPE: ' + ' / '.join(mape_parts))
    else:
        lines.append('   데이터 누적 중 (forecast 실행 후 익일부터 집계)')
    lines.append('')

    kpi = report.get('kpi', {})
    if kpi:
        lines.append('👥 고객 KPI')
        lines.append(f'   완료 예약: {kpi["total_completed"]}건 ({kpi["unique_visitors"]}명)')
        lines.append(f'   재방문율: {kpi["revisit_rate"]}% ({kpi["revisit_count"]}/{kpi["unique_visitors"]}명)')
        revisit_flag = '✅' if kpi['revisit_rate'] >= 30 else ('🟡' if kpi['revisit_rate'] >= 15 else '📉')
        lines[-1] += f'  {revisit_flag}'
        success_flag = '✅' if kpi['success_rate'] >= 95 else ('🟡' if kpi['success_rate'] >= 80 else '🔴')
        lines.append(f'   자동등록 성공률: {kpi["success_rate"]}% ({kpi["total_completed"]}/{kpi["total_completed"]+kpi["failed"]}건)  {success_flag}')
        lines.append('')

    next_start = date_type.fromisoformat(report['next_start'])
    next_end   = date_type.fromisoformat(report['next_end'])
    lines.append(f'🔮 이번주 주요 이벤트 ({next_start.month}/{next_start.day}~{next_end.month}/{next_end.day})')
    if next_events:
        for e in next_events:
            d  = date_type.fromisoformat(e['date'])
            wd = WEEKDAY_KO[d.weekday()]
            lines.append(f'  📚 {d.month}/{d.day}({wd}) {e["name"]}  (+{e["score"]}점)')
    else:
        lines.append('  특이사항 없음')

    return '\n'.join(lines)


def run_rebecca_weekly(target_date_str=None, output_json=False):
    """주간 회고 리포트 (매주 월요일 실행 → 전주 집계)"""
    con = psycopg2.connect(PG_SKA)

    try:
        today = date_type.fromisoformat(target_date_str) if target_date_str else date_type.today()

        days_since_monday = today.weekday()
        week_start = today - timedelta(days=days_since_monday + 7)
        week_end   = week_start + timedelta(days=6)

        next_start = today
        next_end   = today + timedelta(days=6 - today.weekday())

        summary       = get_week_summary(con, week_start, week_end)
        accuracy      = get_weekly_accuracy(con, week_start, week_end)
        forecast_mape = get_weekly_forecast_mape(con, week_start, week_end)
        next_events   = get_next_week_events(con, next_start, next_end)
    finally:
        con.close()

    kpi = get_weekly_kpi(week_start, week_end)

    report = {
        'week_start':    str(week_start),
        'week_end':      str(week_end),
        'next_start':    str(next_start),
        'next_end':      str(next_end),
        'summary':       summary,
        'accuracy':      accuracy,
        'forecast_mape': forecast_mape,
        'next_events':   next_events,
        'kpi':           kpi,
    }

    if output_json:
        print(json.dumps(report, ensure_ascii=False, default=str, indent=2))
    else:
        print(format_weekly_review(report))

    # RAG: 주간 요약 저장
    if _rag:
        try:
            s = summary
            valid_mapes = [a['mape'] for a in accuracy if a.get('mape') is not None]
            avg_mape_str = f'평균MAPE {sum(valid_mapes)/len(valid_mapes):.1f}%' if valid_mapes else 'MAPE없음'
            rag_summary = (
                f'[주간 현황 {report["week_start"]}~{report["week_end"]}] '
                f'주간매출 {s["total"]:,}원 | 일평균 {s["avg"]:,}원 | 예약 {s["reservations"]}건 | {avg_mape_str}'
            )
            _rag.store('operations', rag_summary, {
                'week_start':  report['week_start'],
                'week_end':    report['week_end'],
                'type':        'weekly_report',
                'total':       s['total'],
                'avg':         s['avg'],
                'reservations': s['reservations'],
            }, 'rebecca')
        except Exception:
            pass

    return report


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run_rebecca(target_date_str=None, output_json=False):
    con = psycopg2.connect(PG_SKA)

    try:
        date_str = target_date_str or get_latest_date(con)
        if not date_str:
            print('[REBECCA] ❌ revenue_daily에 데이터 없음')
            return None

        d = date_type.fromisoformat(date_str)

        today_data = get_day(con, date_str)
        if not today_data:
            print(f'[REBECCA] ❌ {date_str} 데이터 없음')
            return None

        prev_day_str  = str(d - timedelta(days=1))
        prev_week_str = str(d - timedelta(days=7))
        tomorrow_str  = str(d + timedelta(days=1))

        prev_day  = get_day(con, prev_day_str)
        prev_week = get_day(con, prev_week_str)
        avg_7d    = get_avg_7d(con, date_str)
        monthly   = get_monthly(con, date_str)
        env_today    = get_env(con, date_str)
        env_tomorrow = get_env(con, tomorrow_str)
        bars      = get_recent_bars(con, date_str, n=7)
        anomalies = detect_anomalies(today_data, avg_7d, env_today)
        prev_forecast = get_yesterday_forecast(con, date_str)  # ska-014
        tomorrow_forecast = get_forecast_context(con, tomorrow_str)
    finally:
        con.close()

    report = {
        'date':          date_str,
        'today':         today_data,
        'prev_day':      prev_day,
        'prev_week':     prev_week,
        'avg_7d':        avg_7d,
        'monthly':       monthly,
        'env_today':     env_today,
        'env_tomorrow':  env_tomorrow,
        'recent_bars':   bars,
        'anomalies':     anomalies,
        'prev_forecast': prev_forecast,  # ska-014: 어제 예측값
        'tomorrow_forecast': tomorrow_forecast,
    }

    # RAG: 이상 감지 시 과거 유사 사례 검색
    rag_past_cases = ''
    if anomalies and _rag:
        try:
            query = ' '.join(anomalies)[:200]
            hits = _rag.search('operations', query, limit=3, threshold=0.55)
            if hits:
                rag_past_cases = '\n\n[과거 유사 사례]\n' + '\n'.join(
                    f'- {h["content"][:180]}' for h in hits
                )
        except Exception:
            pass

    if output_json:
        if rag_past_cases:
            report['rag_past_cases'] = rag_past_cases
        print(json.dumps(report, ensure_ascii=False, default=str, indent=2))
    else:
        tg_text = format_telegram(report)
        if rag_past_cases:
            tg_text += rag_past_cases
        print(tg_text)

    # RAG: 일간 현황 요약 저장
    if _rag:
        try:
            rev = today_data['revenue']
            occ = today_data['occupancy_rate'] * 100
            anom_str = ' | '.join(anomalies) if anomalies else '이상 없음'
            rag_summary = (
                f'[일간 현황 {date_str}] '
                f'매출 {rev:,}원 | 가동률 {occ:.1f}% | {anom_str}'
            )
            _rag.store('operations', rag_summary, {
                'date':    date_str,
                'type':    'daily_report',
                'revenue': rev,
                'occ':     round(occ, 1),
                'has_anomaly': len(anomalies) > 0,
            }, 'rebecca')
        except Exception:
            pass

    return report


if __name__ == '__main__':
    target_date, output_json, mode = parse_args()
    if mode == 'weekly':
        run_rebecca_weekly(target_date, output_json)
    else:
        run_rebecca(target_date, output_json)
