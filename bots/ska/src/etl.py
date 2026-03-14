"""
ska-002: PostgreSQL reservation → PostgreSQL ska ETL 모듈
ska-009: realized MAPE 추적 및 feature store 동기화

소스: PostgreSQL jay DB, reservation 스키마
  - daily_summary: 일별 매출 집계
  - reservations:  예약 건수·가동률 계산용

타겟: PostgreSQL jay DB, ska 스키마
  - revenue_daily:          일별 매출·가동률 집계
  - training_feature_daily: 학습/보정용 feature store

실행: bots/ska/venv/bin/python bots/ska/src/etl.py [--days=90]
launchd: 매일 00:30 (ai.ska.etl)
"""
import sys
import os
import psycopg2
from psycopg2.extras import DictCursor
from datetime import datetime, timedelta, date as date_type

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))
from bots.ska.lib.feature_store import ensure_training_feature_table, sync_training_feature_store

PG_RES = "dbname=jay options='-c search_path=reservation,public'"
PG_SKA = "dbname=jay options='-c search_path=ska,public'"

# 영업시간: 09~22시, 룸 3개 → 하루 최대 39시간
BIZ_START_H = 9
BIZ_END_H   = 22
NUM_ROOMS   = 3
MAX_HOURS   = (BIZ_END_H - BIZ_START_H) * NUM_ROOMS  # 39


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

def _dict_qry(con, sql, params=()):
    """SELECT → dict-style rows (column name access)"""
    cur = con.cursor(cursor_factory=DictCursor)
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def _run(con, sql, params=()):
    """INSERT/UPDATE/DELETE + commit"""
    cur = con.cursor()
    cur.execute(sql, params)
    cur.close()
    con.commit()


# ─── MAPE 추적 ──────────────────────────────────────────────────────────────────

def track_forecast_accuracy(res_con, ska_con, yesterday):
    """어제의 forecast vs actual 비교 → 요약 반환 (중복 테이블 저장 없음)"""
    yesterday_str = str(yesterday)

    actual_row = _one(ska_con,
        "SELECT actual_revenue FROM revenue_daily WHERE date = %s", (yesterday_str,))
    if not actual_row or actual_row[0] is None:
        print(f'[ETL] ⚠️ MAPE: 어제({yesterday_str}) 실제 매출 없음 — 스킵')
        return None

    actual_rev = int(actual_row[0])

    forecast_row = _one(ska_con, """
        SELECT
            COALESCE((predictions->>'yhat')::int, 0) AS predicted_revenue,
            model_version
        FROM ska.forecast_results
        WHERE forecast_date = %s
        ORDER BY created_at DESC
        LIMIT 1
    """, (yesterday_str,))
    if not forecast_row:
        forecast_row = _one(ska_con, """
            SELECT predicted_revenue, model_version
            FROM forecast
            WHERE target_date = %s
            ORDER BY created_at DESC
            LIMIT 1
        """, (yesterday_str,))
    if not forecast_row:
        print(f'[ETL] ⚠️ MAPE: 어제({yesterday_str}) 예측값 없음 — 스킵')
        return None

    predicted = int(forecast_row[0])
    model_ver = forecast_row[1]
    error     = actual_rev - predicted
    abs_error = abs(error)
    mape      = round(abs_error / actual_rev * 100, 2) if actual_rev > 0 else None

    sign   = '+' if error >= 0 else ''
    mape_s = f'{mape:.1f}%' if mape is not None else 'N/A'
    warn   = '  ⚠️ 15% 초과!' if mape is not None and mape > 15 else ''
    print(f'[ETL] 📊 MAPE: {yesterday_str}  예측={predicted:,}  실제={actual_rev:,}  오차={sign}{error:,}원  MAPE={mape_s}{warn}')
    return {
        'target_date': yesterday_str,
        'actual_revenue': actual_rev,
        'predicted_revenue': predicted,
        'error': error,
        'abs_error': abs_error,
        'mape': mape,
        'model_version': model_ver,
    }


def parse_days_arg():
    for arg in sys.argv[1:]:
        if arg.startswith('--days='):
            try:
                return int(arg.split('=', 1)[1])
            except ValueError:
                print(f'[경고] --days 값 파싱 실패: {arg} — 기본값 90 사용')
    return 90


def hhmm_to_minutes(t):
    """'HH:MM' → 분"""
    try:
        h, m = t.split(':')
        return int(h) * 60 + int(m)
    except Exception:
        print(f'[경고] hhmm_to_minutes: 시간 파싱 실패 ({t!r}) — 0분으로 처리')
        return 0


def calc_booked_hours(reservations):
    """예약 목록(dict 리스트)에서 총 예약 시간 합계 (시간 단위, 소수점)"""
    total_min = 0
    for r in reservations:
        start_min = hhmm_to_minutes(r['start_time'])
        end_min   = hhmm_to_minutes(r['end_time'])
        duration  = end_min - start_min
        if duration > 0:
            total_min += duration
    return total_min / 60.0


def run_etl(days_back=90):
    today = date_type.today()
    start = today - timedelta(days=days_back)

    print(f'[ETL] 시작: {start} ~ {today} (최근 {days_back}일)')
    print('[ETL] 소스: PostgreSQL reservation 스키마')
    print('[ETL] 타겟: PostgreSQL ska 스키마')

    res_con = psycopg2.connect(PG_RES)
    ska_con = psycopg2.connect(PG_SKA)

    try:
        ensure_training_feature_table(ska_con)

        # daily_summary 로드 (dict-style row access)
        summary_rows = _dict_qry(res_con, """
            SELECT date, total_amount, pickko_total, pickko_study_room, general_revenue
            FROM daily_summary
            WHERE date >= %s AND date <= %s
            ORDER BY date
        """, (str(start), str(today)))

        upserted = 0
        skipped  = 0

        for row in summary_rows:
            d = str(row['date'])  # 'YYYY-MM-DD'

            actual_revenue    = row['total_amount'] or 0
            studyroom_revenue = actual_revenue - (row['general_revenue'] or 0)
            general_revenue   = row['general_revenue'] or 0

            # 해당 날짜 완료 예약 (status='completed')
            res_rows = _dict_qry(res_con, """
                SELECT start_time, end_time, room, status
                FROM reservations
                WHERE date = %s
            """, (d,))

            completed = [r for r in res_rows if r['status'] == 'completed']
            total_reservations = len(completed)
            cancellation_count = 0

            booked_hours   = calc_booked_hours(completed)
            occupancy_rate = round(booked_hours / MAX_HOURS, 4) if MAX_HOURS > 0 else 0.0

            # PostgreSQL upsert (PRIMARY KEY = date)
            cur = ska_con.cursor()
            cur.execute("""
                INSERT INTO revenue_daily
                  (date, actual_revenue, occupancy_rate, total_reservations,
                   cancellation_count, studyroom_revenue, general_revenue, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (date) DO UPDATE SET
                  actual_revenue      = EXCLUDED.actual_revenue,
                  occupancy_rate      = EXCLUDED.occupancy_rate,
                  total_reservations  = EXCLUDED.total_reservations,
                  cancellation_count  = EXCLUDED.cancellation_count,
                  studyroom_revenue   = EXCLUDED.studyroom_revenue,
                  general_revenue     = EXCLUDED.general_revenue,
                  updated_at          = EXCLUDED.updated_at
            """, (d, actual_revenue, occupancy_rate, total_reservations,
                  cancellation_count, studyroom_revenue, general_revenue))
            cur.close()
            upserted += 1

        ska_con.commit()

        # ska-009: 어제 MAPE 추적
        yesterday = today - timedelta(days=1)
        track_forecast_accuracy(res_con, ska_con, yesterday)
        synced = sync_training_feature_store(ska_con, days=max(days_back, 365))

        # 결과 확인
        total_rows = _one(ska_con, "SELECT COUNT(*) FROM revenue_daily")[0]
        nonzero    = _one(ska_con, "SELECT COUNT(*) FROM revenue_daily WHERE actual_revenue > 0")[0]
        print(f'[ETL] ✅ 완료: {upserted}건 upsert (스킵 {skipped}건)')
        print(f'[ETL] revenue_daily 총 {total_rows}행 / 매출 기록 있는 날: {nonzero}일')
        print(f'[ETL] training_feature_daily 동기화 완료 ({synced}행 대상)')

        # 최근 5일 미리보기
        preview = _qry(ska_con, """
            SELECT date, actual_revenue, occupancy_rate, total_reservations
            FROM revenue_daily
            ORDER BY date DESC
            LIMIT 5
        """)
        print('[ETL] 최근 5일:')
        for p in preview:
            print(f'  {p[0]}  매출={p[1]:,}원  가동률={p[2]*100:.1f}%  예약={p[3]}건')

        return upserted
    finally:
        res_con.close()
        ska_con.close()


if __name__ == '__main__':
    days = parse_days_arg()
    run_etl(days)
