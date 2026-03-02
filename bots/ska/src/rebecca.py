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
  - 전주 예측 정확도 (MAPE) — forecast_accuracy 테이블
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
import sqlite3
import duckdb
from datetime import date as date_type, timedelta

DUCKDB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'db', 'ska.duckdb')
)
STATE_DB_PATH = os.path.expanduser('~/.openclaw/workspace/state.db')

WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일']


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
    row = con.execute(
        "SELECT MAX(date) FROM revenue_daily WHERE actual_revenue > 0"
    ).fetchone()
    return str(row[0]) if row[0] else None


def get_day(con, date_str):
    """특정 날짜의 revenue_daily 행"""
    row = con.execute("""
        SELECT date, actual_revenue, occupancy_rate, total_reservations,
               cancellation_count, studyroom_revenue, general_revenue
        FROM revenue_daily WHERE date = ?
    """, (date_str,)).fetchone()
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
    rows = con.execute("""
        SELECT AVG(actual_revenue), AVG(occupancy_rate), COUNT(*)
        FROM revenue_daily
        WHERE date >= ? AND date < ?
    """, (
        str(date_type.fromisoformat(date_str) - timedelta(days=7)),
        date_str
    )).fetchone()
    return {
        'avg_revenue':    round(rows[0] or 0),
        'avg_occupancy':  rows[1] or 0.0,
        'days_count':     rows[2] or 0,
    }


def get_monthly(con, date_str):
    """해당 월 집계"""
    ym = date_str[:7]  # 'YYYY-MM'
    row = con.execute("""
        SELECT COUNT(*) as days,
               SUM(actual_revenue) as total,
               AVG(actual_revenue) as daily_avg,
               SUM(total_reservations) as total_res,
               MAX(actual_revenue) as peak,
               MIN(CASE WHEN actual_revenue > 0 THEN actual_revenue END) as trough
        FROM revenue_daily
        WHERE strftime(date, '%Y-%m') = ? AND date <= ?
    """, (ym, date_str)).fetchone()

    # 월말 예측: 일평균 × 월 잔여일수
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
    row = con.execute("""
        SELECT holiday_flag, holiday_name, rain_prob, temperature,
               exam_score, vacation_flag, festival_flag, festival_name
        FROM environment_factors WHERE date = ?
    """, (date_str,)).fetchone()
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
    rows = con.execute("""
        SELECT date, actual_revenue, occupancy_rate
        FROM revenue_daily
        WHERE date <= ?
        ORDER BY date DESC LIMIT ?
    """, (date_str, n)).fetchall()
    return [{'date': str(r[0]), 'revenue': r[1] or 0, 'occ': r[2] or 0.0}
            for r in reversed(rows)]


# ─── 이상 감지 ─────────────────────────────────────────────────────────────────

def detect_anomalies(today, avg_7d, env_today):
    anomalies = []
    rev = today['revenue']
    avg = avg_7d['avg_revenue']

    # 무매출 + 비공휴일·비방학
    is_holiday = env_today and env_today['holiday_flag']
    is_vacation = env_today and env_today['vacation_flag']
    if rev == 0 and not is_holiday and not is_vacation:
        anomalies.append('⚠️ 매출 0원 (비공휴일·비방학)')

    # 매출 급감: 7일평균의 40% 미만
    if avg > 0 and rev < avg * 0.4 and rev > 0:
        anomalies.append(f'⚠️ 매출 급감 (7일 평균 {avg:,}원 대비 {rev/avg*100:.0f}%)')

    # 매출 급등: 7일평균의 250% 초과
    if avg > 0 and rev > avg * 2.5:
        anomalies.append(f'📈 매출 급등 (7일 평균 대비 +{rev/avg*100-100:.0f}%)')

    return anomalies


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
    bars  = report['recent_bars']
    anomalies = report['anomalies']

    target_date = date_type.fromisoformat(d['date'])
    wd = WEEKDAY_KO[target_date.weekday()]
    m, day = target_date.month, target_date.day

    prev_day = report.get('prev_day')
    prev_week = report.get('prev_week')

    # ── 헤더 ──
    lines = [
        f'📊 레베카 일간 현황 리포트',
        f'{"─"*15}',
        f'📅 {m}월 {day}일 ({wd})',
        '',
    ]

    # ── 매출 ──
    lines.append(f'💰 매출: {d["revenue"]:,}원')
    if prev_day:
        prev_wd = WEEKDAY_KO[date_type.fromisoformat(prev_day['date']).weekday()]
        lines.append(f'   ↕ 전일({prev_wd}):    {pct_str(d["revenue"], prev_day["revenue"])}')
    if prev_week:
        lines.append(f'   ↕ 전주({wd}):    {pct_str(d["revenue"], prev_week["revenue"])}')
    if avg['avg_revenue'] > 0:
        lines.append(f'   ↕ 7일 평균:    {pct_str(d["revenue"], avg["avg_revenue"])}  (평균 {avg["avg_revenue"]:,}원)')
    lines.append('')

    # ── 가동률·예약 ──
    occ_pct = d['occupancy_rate'] * 100
    booked_h = d['occupancy_rate'] * 39
    lines.append(f'🏠 가동률: {occ_pct:.1f}%  ({booked_h:.1f}h / 39h)')
    lines.append(f'📋 예약: {d["total_reservations"]}건')

    # 매출 분류 (studyroom + general이 actual과 다를 수 있음)
    st_rev = d['studyroom_revenue']
    ge_rev = d['general_revenue']
    if st_rev + ge_rev > 0:
        lines.append(f'   스터디룸 {st_rev:,}원  /  일반이용 {ge_rev:,}원')
    lines.append('')

    # ── 최근 7일 바 차트 ──
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

    # ── 이번달 현황 ──
    elapsed = mon['elapsed']
    lines.append(f'📅 {mon["ym"][5:7]}월 현황 ({elapsed}일 경과 / {mon["days_in_month"]}일)')
    lines.append(f'   월 매출:  {mon["total"]:,}원')
    lines.append(f'   일 평균:  {mon["daily_avg"]:,}원')
    lines.append(f'   예상 마감: ~{mon["projected"]:,}원')
    lines.append('')

    # ── 이상 감지 ──
    if anomalies:
        for a in anomalies:
            lines.append(a)
    else:
        lines.append('✅ 이상 없음')
    lines.append('')

    # ── 내일 환경 ──
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

    return '\n'.join(lines)


# ─── 주간 회고 (ska-009) ──────────────────────────────────────────────────────

def get_week_summary(con, week_start, week_end):
    """전주 매출 집계"""
    row = con.execute("""
        SELECT SUM(actual_revenue), AVG(actual_revenue),
               SUM(total_reservations), COUNT(*)
        FROM revenue_daily
        WHERE date >= ? AND date <= ?
    """, (str(week_start), str(week_end))).fetchone()
    return {
        'total':        row[0] or 0,
        'avg':          round(row[1] or 0),
        'reservations': row[2] or 0,
        'days':         row[3] or 0,
    }


def get_weekly_accuracy(con, week_start, week_end):
    """전주 예측 정확도 조회 (forecast_accuracy 테이블)"""
    try:
        rows = con.execute("""
            SELECT target_date, actual_revenue, predicted_revenue, error, mape, model_version
            FROM forecast_accuracy
            WHERE target_date >= ? AND target_date <= ?
            ORDER BY target_date
        """, (str(week_start), str(week_end))).fetchall()
        return [{'date': str(r[0]), 'actual': r[1], 'predicted': r[2],
                 'error': r[3], 'mape': r[4], 'model_version': r[5]}
                for r in rows]
    except Exception:
        return []  # 테이블 미존재 시 빈 리스트


def get_next_week_events(con, next_start, next_end):
    """이번 주 주요 시험 이벤트"""
    try:
        rows = con.execute("""
            SELECT date, exam_name, score_weight
            FROM exam_events
            WHERE date >= ? AND date <= ?
            ORDER BY date
        """, (str(next_start), str(next_end))).fetchall()
        return [{'date': str(r[0]), 'name': r[1], 'score': r[2]} for r in rows]
    except Exception:
        return []


def get_weekly_kpi(week_start, week_end):
    """SQLite state.db에서 재방문율·자동등록 성공률 집계"""
    try:
        con = sqlite3.connect(STATE_DB_PATH)
        w_start = str(week_start)
        w_end   = str(week_end)

        # 이번 주 완료 예약 (phone 목록)
        rows = con.execute("""
            SELECT phone
            FROM reservations
            WHERE date >= ? AND date <= ?
              AND status = 'completed'
              AND seen_only = 0
        """, (w_start, w_end)).fetchall()
        week_phones = [r[0] for r in rows]
        total_completed = len(week_phones)

        # 재방문자 = 이번 주 완료자 중 이전에도 completed 기록이 있는 phone
        revisit_count = 0
        for phone in set(week_phones):
            prev = con.execute("""
                SELECT COUNT(*) FROM reservations
                WHERE phone = ?
                  AND status = 'completed'
                  AND seen_only = 0
                  AND date < ?
            """, (phone, w_start)).fetchone()[0]
            if prev > 0:
                revisit_count += 1

        unique_visitors = len(set(week_phones))
        revisit_rate = round(revisit_count / unique_visitors * 100) if unique_visitors > 0 else 0

        # 자동등록 성공률 = completed / (completed + failed) in the week
        failed = con.execute("""
            SELECT COUNT(*) FROM reservations
            WHERE date >= ? AND date <= ?
              AND status = 'failed'
              AND seen_only = 0
        """, (w_start, w_end)).fetchone()[0]

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
    except Exception as e:
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

    # ── 전주 실적 ──
    lines.append(f'💰 주간 매출: {summary["total"]:,}원')
    lines.append(f'   일 평균:  {summary["avg"]:,}원 ({summary["days"]}영업일)')
    lines.append(f'   총 예약:  {summary["reservations"]}건')
    lines.append('')

    # ── 예측 정확도 (MAPE) ──
    if accuracy_list:
        valid = [a for a in accuracy_list if a['mape'] is not None]
        avg_mape = sum(a['mape'] for a in valid) / len(valid) if valid else None

        lines.append('🎯 예측 정확도')
        for a in accuracy_list:
            d  = date_type.fromisoformat(a['date'])
            wd = WEEKDAY_KO[d.weekday()]
            mape_s = f'{a["mape"]:.1f}%' if a['mape'] is not None else 'N/A'
            sign   = '+' if (a['error'] or 0) >= 0 else ''
            flag   = '⚠️' if (a['mape'] or 0) > 15 else '  '
            lines.append(
                f'  {flag}{d.month}/{d.day}({wd})  '
                f'예측 {a["predicted"]:,} → 실제 {a["actual"]:,}'
                f'  ({sign}{a["error"]:,}원, {mape_s})'
            )

        if avg_mape is not None:
            lines.append(f'   평균 MAPE: {avg_mape:.1f}%  ', )
            if avg_mape <= 10:
                lines[-1] += '✅ 양호'
            elif avg_mape <= 20:
                lines[-1] += '🟡 주의'
            else:
                lines[-1] += '🔴 모델 검토 필요'
    else:
        lines.append('🎯 예측 정확도: 데이터 누적 중 (forecast 실행 후 익일부터 집계)')
    lines.append('')

    # ── 재방문율·자동등록 성공률 ──
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

    # ── 이번 주 이벤트 예고 ──
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
    con = duckdb.connect(DUCKDB_PATH)

    try:
        today = date_type.fromisoformat(target_date_str) if target_date_str else date_type.today()

        # 전주 월요일~일요일
        days_since_monday = today.weekday()  # 0=월요일
        week_start = today - timedelta(days=days_since_monday + 7)
        week_end   = week_start + timedelta(days=6)

        # 이번 주 (오늘~일요일)
        next_start = today
        next_end   = today + timedelta(days=6 - today.weekday())

        summary     = get_week_summary(con, week_start, week_end)
        accuracy    = get_weekly_accuracy(con, week_start, week_end)
        next_events = get_next_week_events(con, next_start, next_end)
    finally:
        con.close()

    kpi = get_weekly_kpi(week_start, week_end)

    report = {
        'week_start': str(week_start),
        'week_end':   str(week_end),
        'next_start': str(next_start),
        'next_end':   str(next_end),
        'summary':    summary,
        'accuracy':   accuracy,
        'next_events': next_events,
        'kpi':         kpi,
    }

    if output_json:
        print(json.dumps(report, ensure_ascii=False, default=str, indent=2))
    else:
        print(format_weekly_review(report))

    return report


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def run_rebecca(target_date_str=None, output_json=False):
    con = duckdb.connect(DUCKDB_PATH)

    try:
        # 보고 날짜 결정
        date_str = target_date_str or get_latest_date(con)
        if not date_str:
            print('[REBECCA] ❌ revenue_daily에 데이터 없음')
            return None

        d = date_type.fromisoformat(date_str)

        # 데이터 조회
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
    }

    if output_json:
        print(json.dumps(report, ensure_ascii=False, default=str, indent=2))
    else:
        print(format_telegram(report))

    return report


if __name__ == '__main__':
    target_date, output_json, mode = parse_args()
    if mode == 'weekly':
        run_rebecca_weekly(target_date, output_json)
    else:
        run_rebecca(target_date, output_json)
