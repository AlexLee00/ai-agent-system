"""
ska-002: SQLite → DuckDB ETL 모듈
ska-009: forecast_accuracy 테이블 관리 + MAPE 추적 추가

소스: ~/.openclaw/workspace/state.db
  - daily_summary: 일별 매출 집계
  - reservations:  예약 건수·가동률 계산용

타겟: bots/ska/db/ska.duckdb
  - revenue_daily:       일별 매출·가동률 집계
  - forecast_accuracy:   예측 vs 실제 오차 추적 (ska-009)

실행: bots/ska/venv/bin/python bots/ska/src/etl.py [--days=90]
launchd: 매일 00:30 (ai.ska.etl)
"""
import sys
import os
import sqlite3
from datetime import datetime, timedelta, date as date_type
import duckdb

SQLITE_PATH = os.path.expanduser('~/.openclaw/workspace/state.db')
DUCKDB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), '..', 'db', 'ska.duckdb')
)

# 영업시간: 09~22시, 룸 3개 → 하루 최대 39시간
BIZ_START_H = 9
BIZ_END_H   = 22
NUM_ROOMS   = 3
MAX_HOURS   = (BIZ_END_H - BIZ_START_H) * NUM_ROOMS  # 39


def ensure_forecast_accuracy_table(duckdb_con):
    """forecast_accuracy 테이블 + 시퀀스 초기화 (없을 때만)"""
    duckdb_con.execute("CREATE SEQUENCE IF NOT EXISTS forecast_accuracy_id_seq START 1")
    duckdb_con.execute("""
        CREATE TABLE IF NOT EXISTS forecast_accuracy (
            id                INTEGER PRIMARY KEY,
            target_date       DATE    NOT NULL,
            actual_revenue    INTEGER NOT NULL,
            predicted_revenue INTEGER NOT NULL,
            error             INTEGER,
            abs_error         INTEGER,
            mape              DOUBLE,
            model_version     VARCHAR,
            created_at        TIMESTAMP DEFAULT current_timestamp
        )
    """)


def track_forecast_accuracy(duckdb_con, yesterday):
    """어제의 forecast vs actual 비교 → forecast_accuracy 저장 (피드백 루프)"""
    yesterday_str = str(yesterday)

    actual_row = duckdb_con.execute(
        "SELECT actual_revenue FROM revenue_daily WHERE date = ?", (yesterday_str,)
    ).fetchone()
    if not actual_row or actual_row[0] is None:
        print(f'[ETL] ⚠️ MAPE: 어제({yesterday_str}) 실제 매출 없음 — 스킵')
        return

    actual_rev = int(actual_row[0])

    forecast_row = duckdb_con.execute("""
        SELECT predicted_revenue, model_version
        FROM forecast
        WHERE target_date = ?
        ORDER BY created_at DESC
        LIMIT 1
    """, (yesterday_str,)).fetchone()
    if not forecast_row:
        print(f'[ETL] ⚠️ MAPE: 어제({yesterday_str}) 예측값 없음 — 스킵')
        return

    predicted = int(forecast_row[0])
    model_ver = forecast_row[1]
    error     = actual_rev - predicted
    abs_error = abs(error)
    mape      = round(abs_error / actual_rev * 100, 2) if actual_rev > 0 else None

    # 기존 레코드 교체 (같은 날짜+모델 버전)
    duckdb_con.execute(
        "DELETE FROM forecast_accuracy WHERE target_date = ? AND model_version = ?",
        (yesterday_str, model_ver)
    )
    next_id = duckdb_con.execute("SELECT nextval('forecast_accuracy_id_seq')").fetchone()[0]
    duckdb_con.execute("""
        INSERT INTO forecast_accuracy
          (id, target_date, actual_revenue, predicted_revenue,
           error, abs_error, mape, model_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (next_id, yesterday_str, actual_rev, predicted,
          error, abs_error, mape, model_ver))

    sign   = '+' if error >= 0 else ''
    mape_s = f'{mape:.1f}%' if mape is not None else 'N/A'
    warn   = '  ⚠️ 15% 초과!' if mape is not None and mape > 15 else ''
    print(f'[ETL] 📊 MAPE: {yesterday_str}  예측={predicted:,}  실제={actual_rev:,}  오차={sign}{error:,}원  MAPE={mape_s}{warn}')


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
    """예약 목록(Row 리스트)에서 총 예약 시간 합계 (시간 단위, 소수점)"""
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
    print(f'[ETL] 소스: {SQLITE_PATH}')
    print(f'[ETL] 타겟: {DUCKDB_PATH}')

    if not os.path.exists(SQLITE_PATH):
        print(f'[ETL] ❌ SQLite DB 없음: {SQLITE_PATH}')
        sys.exit(1)

    sqlite_con = sqlite3.connect(SQLITE_PATH)
    sqlite_con.row_factory = sqlite3.Row
    duckdb_con = duckdb.connect(DUCKDB_PATH)

    try:
        # daily_summary 로드
        summary_rows = sqlite_con.execute("""
            SELECT date, total_amount, pickko_total, pickko_study_room, general_revenue
            FROM daily_summary
            WHERE date >= ? AND date <= ?
            ORDER BY date
        """, (str(start), str(today))).fetchall()

        upserted = 0
        skipped  = 0

        for row in summary_rows:
            d = row['date']  # 'YYYY-MM-DD'

            # actual_revenue: total_amount 기준 (입금일 기준 — 예약 확정+키오스크)
            # pickko_total은 이용일 기준이라 미래 예약은 반영 안 됨 → 사용 안 함
            actual_revenue    = row['total_amount'] or 0
            studyroom_revenue = actual_revenue - (row['general_revenue'] or 0)
            general_revenue   = row['general_revenue'] or 0

            # 해당 날짜 완료 예약 (status='completed')
            res_rows = sqlite_con.execute("""
                SELECT start_time, end_time, room, status
                FROM reservations
                WHERE date = ?
            """, (d,)).fetchall()

            completed = [r for r in res_rows if r['status'] == 'completed']
            total_reservations = len(completed)

            # 취소 건수: completed 제외 + 네이버 취소 탭에서 감지된 것
            # cancelled_keys는 composite_key 기반이라 날짜 분리 불가 → 0으로 유지
            cancellation_count = 0

            # 가동률: 완료 예약 기준 총 예약시간 / 최대 가용시간
            booked_hours   = calc_booked_hours(completed)
            occupancy_rate = round(booked_hours / MAX_HOURS, 4) if MAX_HOURS > 0 else 0.0

            # DuckDB upsert (PRIMARY KEY = date)
            duckdb_con.execute("""
                INSERT OR REPLACE INTO revenue_daily
                  (date, actual_revenue, occupancy_rate, total_reservations,
                   cancellation_count, studyroom_revenue, general_revenue, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, current_timestamp)
            """, (d, actual_revenue, occupancy_rate, total_reservations,
                  cancellation_count, studyroom_revenue, general_revenue))
            upserted += 1

        # ska-009: forecast_accuracy 테이블 초기화 + 어제 MAPE 추적
        ensure_forecast_accuracy_table(duckdb_con)
        yesterday = today - timedelta(days=1)
        track_forecast_accuracy(duckdb_con, yesterday)

        # 결과 확인
        total_rows = duckdb_con.execute("SELECT COUNT(*) FROM revenue_daily").fetchone()[0]
        nonzero    = duckdb_con.execute("SELECT COUNT(*) FROM revenue_daily WHERE actual_revenue > 0").fetchone()[0]
        print(f'[ETL] ✅ 완료: {upserted}건 upsert (스킵 {skipped}건)')
        print(f'[ETL] revenue_daily 총 {total_rows}행 / 매출 기록 있는 날: {nonzero}일')

        # 최근 5일 미리보기
        preview = duckdb_con.execute("""
            SELECT date, actual_revenue, occupancy_rate, total_reservations
            FROM revenue_daily
            ORDER BY date DESC
            LIMIT 5
        """).fetchall()
        print('[ETL] 최근 5일:')
        for p in preview:
            print(f'  {p[0]}  매출={p[1]:,}원  가동률={p[2]*100:.1f}%  예약={p[3]}건')

        return upserted
    finally:
        sqlite_con.close()
        duckdb_con.close()


if __name__ == '__main__':
    days = parse_days_arg()
    run_etl(days)
