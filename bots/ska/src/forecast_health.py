"""
ska-015: 포캐스트 헬스 리포트

목적:
  - forecast_results + revenue_daily 기준 최근 정확도 상태를 점검
  - 최근 MAPE / bias / 요일 편향 / 큰 오차 사례를 한 번에 보여줌

실행:
  bots/ska/venv/bin/python bots/ska/src/forecast_health.py [--days=30] [--json]
"""
import json
import os
import sys
import subprocess
import psycopg2
from datetime import date as date_type, timedelta

sys.path.insert(0, os.environ.get('PROJECT_ROOT', os.path.expanduser('~/projects/ai-agent-system')))
from packages.core.lib.health_core import build_health_report, build_health_decision_section

PG_SKA = "dbname=jay options='-c search_path=ska,public'"
WEEKDAY_KO = ['월', '화', '수', '목', '금', '토', '일']
PROJECT_ROOT = os.environ.get('PROJECT_ROOT', os.path.expanduser('~/projects/ai-agent-system'))
GEMMA_PILOT_CLI = os.path.join(PROJECT_ROOT, 'packages', 'core', 'scripts', 'gemma-pilot-cli.js')


def _qry(con, sql, params=()):
    cur = con.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows


def sanitize_insight_line(raw_text):
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
        if any('가' <= ch <= '힣' for ch in text):
            candidates.append(text)

    if not candidates:
        return ''

    best = candidates[-1]
    if len(best) > 120:
        return ''
    return best


def build_health_fallback_insight(report):
    summary = report['summary']
    tuning = report.get('tuning_candidate') or {}
    avg_mape = summary.get('avg_mape') or 0
    hit_rate_20 = summary.get('hit_rate_20') or 0
    avg_bias = summary.get('avg_bias') or 0

    if tuning.get('recommended'):
        return f'최근 평균 MAPE {avg_mape:.1f}%와 편향 {avg_bias:+,}원을 기준으로 추가 튜닝 검토가 필요합니다.'
    if hit_rate_20 >= 80 and avg_mape <= 15:
        return f'최근 평균 MAPE {avg_mape:.1f}%로 비교적 안정적이며 현 설정을 유지해도 좋습니다.'
    return f'최근 평균 MAPE {avg_mape:.1f}%, 20% 이내 적중률 {hit_rate_20:.1f}%로 경향 관찰이 필요합니다.'


def parse_args():
    days = 30
    output_json = False
    for arg in sys.argv[1:]:
        if arg.startswith('--days='):
            days = max(7, int(arg.split('=', 1)[1]))
        elif arg == '--json':
            output_json = True
    return days, output_json


def load_accuracy_rows(con, start_date):
    rows = _qry(con, """
        WITH latest AS (
            SELECT DISTINCT ON (fr.forecast_date)
                fr.forecast_date,
                fr.predictions,
                fr.model_version,
                fr.created_at
            FROM ska.forecast_results fr
            WHERE fr.forecast_date >= %s
            ORDER BY fr.forecast_date, fr.created_at DESC
        )
        SELECT
            latest.forecast_date,
            rd.actual_revenue,
            (latest.predictions->>'yhat')::int AS predicted_revenue,
            ((latest.predictions->>'yhat')::int - rd.actual_revenue) AS error,
            CASE
                WHEN rd.actual_revenue > 0
                THEN ABS(((latest.predictions->>'yhat')::float - rd.actual_revenue) / rd.actual_revenue) * 100
                ELSE NULL
            END AS mape,
            COALESCE((latest.predictions->>'reservation_count')::int, 0) AS reservation_count,
            COALESCE((latest.predictions->>'reservation_booked_hours')::float, 0.0) AS reservation_booked_hours,
            COALESCE((latest.predictions->>'confidence')::float, 0.0) AS confidence,
            latest.model_version
        FROM latest
        JOIN ska.revenue_daily rd ON rd.date = latest.forecast_date
        WHERE rd.actual_revenue IS NOT NULL
        ORDER BY latest.forecast_date DESC
    """, (str(start_date),))
    return [
        {
            'date': str(r[0]),
            'actual': int(r[1] or 0),
            'predicted': int(r[2] or 0),
            'error': int(r[3] or 0),
            'mape': float(r[4]) if r[4] is not None else None,
            'reservation_count': int(r[5] or 0),
            'reservation_booked_hours': float(r[6] or 0.0),
            'confidence': float(r[7] or 0.0),
            'model_version': r[8] or '',
        }
        for r in rows
    ]


def build_summary(rows):
    valid = [r for r in rows if r['mape'] is not None]
    if not valid:
        return {
            'count': len(rows),
            'valid_count': 0,
            'avg_mape': None,
            'median_mape': None,
            'avg_bias': 0,
            'hit_rate_10': 0,
            'hit_rate_20': 0,
            'avg_confidence': 0.0,
        }

    sorted_mapes = sorted(r['mape'] for r in valid)
    mid = len(sorted_mapes) // 2
    median = (
        sorted_mapes[mid]
        if len(sorted_mapes) % 2 == 1
        else (sorted_mapes[mid - 1] + sorted_mapes[mid]) / 2
    )
    return {
        'count': len(rows),
        'valid_count': len(valid),
        'avg_mape': round(sum(r['mape'] for r in valid) / len(valid), 2),
        'median_mape': round(median, 2),
        'avg_bias': round(sum(r['error'] for r in valid) / len(valid)),
        'hit_rate_10': round(sum(1 for r in valid if r['mape'] <= 10) / len(valid) * 100, 1),
        'hit_rate_20': round(sum(1 for r in valid if r['mape'] <= 20) / len(valid) * 100, 1),
        'avg_confidence': round(sum(r['confidence'] for r in valid) / len(valid), 3),
    }


def build_weekday_bias(rows):
    buckets = {}
    for row in rows:
        if row['mape'] is None:
            continue
        wd = date_type.fromisoformat(row['date']).weekday()
        buckets.setdefault(wd, []).append(row)

    result = []
    for wd, items in sorted(buckets.items()):
        avg_mape = sum(i['mape'] for i in items) / len(items)
        avg_error = round(sum(i['error'] for i in items) / len(items))
        result.append({
            'weekday': WEEKDAY_KO[wd],
            'count': len(items),
            'avg_mape': round(avg_mape, 2),
            'avg_bias': avg_error,
        })
    return result


def build_worst_cases(rows, limit=5):
    valid = [r for r in rows if r['mape'] is not None]
    ranked = sorted(valid, key=lambda r: (-r['mape'], -abs(r['error'])))
    return ranked[:limit]


def build_recommendations(summary, weekday_bias, worst_cases):
    if not summary or summary.get('valid_count', 0) == 0:
        return []

    recs = []
    avg_mape = summary.get('avg_mape') or 0
    avg_bias = summary.get('avg_bias') or 0

    if avg_mape >= 25:
        recs.append('최근 오차가 커서 예측식 재학습 또는 보정 강도 점검이 필요합니다.')
    elif avg_mape >= 15:
        recs.append('중간 수준 오차가 이어지고 있어 예약 구조/환경변수 가중치를 재점검하는 편이 좋습니다.')

    if avg_bias <= -30000:
        recs.append('전반적으로 과소예측 경향이 있어 예약 선행신호와 고매출일 보정치를 더 키우는 것이 좋습니다.')
    elif avg_bias >= 30000:
        recs.append('전반적으로 과대예측 경향이 있어 피크 예약/시험일 가산치를 보수적으로 줄이는 것이 좋습니다.')

    if weekday_bias:
        worst_weekday = max(weekday_bias, key=lambda item: (item['avg_mape'], abs(item['avg_bias'])))
        if worst_weekday['avg_mape'] >= 20:
            recs.append(
                f'{worst_weekday["weekday"]}요일 편향이 커서 요일별 calibration baseline을 우선 점검하는 것이 좋습니다.'
            )

    if worst_cases:
        top = worst_cases[0]
        if top['reservation_count'] <= 5 and top['mape'] >= 30:
            recs.append('예약이 적은 날의 오차가 커서 저예약일 fallback 또는 하한선 규칙을 보강하는 것이 좋습니다.')

    return recs[:3]


def build_tuning_candidate(summary, weekday_bias):
    if not summary or summary.get('valid_count', 0) == 0:
        return {
            'recommended': False,
            'level': 'hold',
            'reasons': ['정확도 데이터가 아직 부족해 튜닝 판단을 보류합니다.'],
        }

    avg_mape = summary.get('avg_mape') or 0
    hit_rate_20 = summary.get('hit_rate_20') or 0
    avg_bias = summary.get('avg_bias') or 0
    worst_weekday = max(weekday_bias, key=lambda item: (item['avg_mape'], abs(item['avg_bias'])), default=None)

    reasons = []
    level = 'hold'
    recommended = False

    if avg_mape > 20:
        recommended = True
        level = 'high'
        reasons.append(f'평균 MAPE가 {avg_mape:.1f}%로 높습니다.')
    elif avg_mape > 15:
        recommended = True
        level = 'medium'
        reasons.append(f'평균 MAPE가 {avg_mape:.1f}%로 튜닝 검토 구간입니다.')

    if hit_rate_20 < 70:
        recommended = True
        level = 'high' if level == 'high' else 'medium'
        reasons.append(f'20% 이내 적중률이 {hit_rate_20:.1f}%로 낮습니다.')

    if abs(avg_bias) >= 50000:
        recommended = True
        level = 'high' if level == 'high' else 'medium'
        reasons.append(f'평균 편향이 {avg_bias:+,}원으로 큽니다.')

    if worst_weekday and worst_weekday['avg_mape'] >= 25:
        recommended = True
        level = 'high' if level == 'high' else 'medium'
        reasons.append(
            f'{worst_weekday["weekday"]}요일 MAPE가 {worst_weekday["avg_mape"]:.1f}%로 높습니다.'
        )

    if not reasons:
        reasons.append('현재 정확도 수준은 관찰 유지 구간입니다.')

    return {
        'recommended': recommended,
        'level': level,
        'reasons': reasons[:3],
    }


def format_text(report):
    summary = report['summary']
    if summary['valid_count'] == 0:
        return build_health_report(
            title='📊 스카 예측 헬스 리포트',
            subtitle='기간: 최근 {}일'.format(report['days']),
            sections=[{'title': '■ 상태', 'lines': ['데이터 누적 중']}],
        )

    avg_bias = summary['avg_bias']
    bias_sign = '+' if avg_bias >= 0 else ''
    sections = [{
        'title': '■ 전체 정확도',
        'lines': [
            f'  평균 MAPE: {summary["avg_mape"]:.2f}%',
            f'  중앙 MAPE: {summary["median_mape"]:.2f}%',
            f'  평균 편향: {bias_sign}{avg_bias:,}원',
            f'  10% 이내 적중률: {summary["hit_rate_10"]:.1f}%',
            f'  20% 이내 적중률: {summary["hit_rate_20"]:.1f}%',
            f'  평균 확신도: {summary["avg_confidence"]*100:.0f}%',
        ],
    }]

    if report['weekday_bias']:
        weekday_lines = []
        for item in report['weekday_bias']:
            bias = item['avg_bias']
            sign = '+' if bias >= 0 else ''
            weekday_lines.append(
                f'  {item["weekday"]}: MAPE {item["avg_mape"]:.1f}% / '
                f'편향 {sign}{bias:,}원 / {item["count"]}건'
            )
        sections.append({'title': '■ 요일별 편향', 'lines': weekday_lines})

    if report['worst_cases']:
        worst_lines = []
        for item in report['worst_cases']:
            d = date_type.fromisoformat(item['date'])
            sign = '+' if item['error'] >= 0 else ''
            worst_lines.append(
                f'  {d.month}/{d.day}({WEEKDAY_KO[d.weekday()]}) '
                f'예측 {item["predicted"]:,} / 실제 {item["actual"]:,} / '
                f'오차 {sign}{item["error"]:,}원 / MAPE {item["mape"]:.1f}%'
            )
        sections.append({'title': '■ 큰 오차 사례', 'lines': worst_lines})

    recommendations = report.get('recommendations') or []
    if recommendations:
        sections.append({
            'title': '■ 개선 추천',
            'lines': [f'  - {rec}' for rec in recommendations],
        })

    tuning_candidate = report.get('tuning_candidate')
    if tuning_candidate:
        sections.append({
            'title': None,
            'lines': build_health_decision_section(
                title='■ 튜닝 판단',
                recommended=tuning_candidate['recommended'],
                level=tuning_candidate['level'],
                reasons=tuning_candidate.get('reasons', []),
                ok_text='현재는 추가 튜닝보다 관찰 유지',
            ),
        })

    insight = ''
    try:
        prompt = f"""당신은 스터디카페 매출 예측 운영 분석가입니다.
최근 평균 MAPE: {summary["avg_mape"]:.2f}%
중앙 MAPE: {summary["median_mape"]:.2f}%
평균 편향: {avg_bias:+,}원
20% 이내 적중률: {summary["hit_rate_20"]:.1f}%

현재 예측 헬스 상태를 한국어 1줄로 간결하게 작성하세요."""
        proc = subprocess.run(
            [
                'node',
                GEMMA_PILOT_CLI,
                '--team=ska',
                '--purpose=gemma-insight',
                '--bot=forecast-health',
                '--requestType=forecast-health-insight',
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
    except Exception as e:
        print(f'[forecast-health] gemma 인사이트 생략: {e}', file=sys.stderr)

    if not insight:
        insight = build_health_fallback_insight(report)

    if insight:
        sections.append({
            'title': '■ AI 요약',
            'lines': [f'  {insight}'],
        })

    return build_health_report(
        title='📊 스카 예측 헬스 리포트',
        subtitle='기간: 최근 {}일'.format(report['days']),
        sections=sections,
    )


def run():
    days, output_json = parse_args()
    today = date_type.today()
    start_date = today - timedelta(days=days)
    con = psycopg2.connect(PG_SKA)
    try:
        rows = load_accuracy_rows(con, start_date)
    finally:
        con.close()

    report = {
        'days': days,
        'summary': build_summary(rows),
        'weekday_bias': build_weekday_bias(rows),
        'worst_cases': build_worst_cases(rows),
        'recommendations': None,
        'tuning_candidate': None,
        'rows': rows if output_json else None,
    }
    report['recommendations'] = build_recommendations(
        report['summary'],
        report['weekday_bias'],
        report['worst_cases'],
    )
    report['tuning_candidate'] = build_tuning_candidate(
        report['summary'],
        report['weekday_bias'],
    )

    if output_json:
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    else:
        print(format_text(report))


if __name__ == '__main__':
    run()
