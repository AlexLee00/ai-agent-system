"""
ska-001: DuckDB 스키마 생성
실행: bots/ska/venv/bin/python bots/ska/scripts/setup-db.py
"""
import duckdb
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'db', 'ska.duckdb')
DB_PATH = os.path.abspath(DB_PATH)

def setup():
    print(f'[ska-DB] 초기화: {DB_PATH}')
    con = duckdb.connect(DB_PATH)

    con.execute("""
        CREATE TABLE IF NOT EXISTS revenue_daily (
            date          DATE PRIMARY KEY,
            actual_revenue        INTEGER DEFAULT 0,
            occupancy_rate        DOUBLE  DEFAULT 0.0,
            total_reservations    INTEGER DEFAULT 0,
            cancellation_count    INTEGER DEFAULT 0,
            studyroom_revenue     INTEGER DEFAULT 0,
            general_revenue       INTEGER DEFAULT 0,
            updated_at            TIMESTAMP DEFAULT current_timestamp
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS environment_factors (
            date            DATE PRIMARY KEY,
            holiday_flag    BOOLEAN DEFAULT false,
            holiday_name    VARCHAR,
            rain_prob       DOUBLE  DEFAULT 0.0,
            temperature     DOUBLE,
            exam_score      INTEGER DEFAULT 0,
            exam_types      VARCHAR,
            vacation_flag   BOOLEAN DEFAULT false,
            festival_flag   BOOLEAN DEFAULT false,
            festival_name   VARCHAR,
            factors_json    VARCHAR,
            created_at      TIMESTAMP DEFAULT current_timestamp,
            updated_at      TIMESTAMP DEFAULT current_timestamp
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS forecast (
            id               INTEGER PRIMARY KEY,
            target_date      DATE NOT NULL,
            predicted_revenue  INTEGER,
            base_forecast    INTEGER,
            env_score        DOUBLE,
            yhat_lower       INTEGER,
            yhat_upper       INTEGER,
            confidence       DOUBLE,
            model_version    VARCHAR DEFAULT 'baseline-v1',
            created_at       TIMESTAMP DEFAULT current_timestamp
        )
    """)

    con.execute("""
        CREATE TABLE IF NOT EXISTS exam_events (
            date         DATE    NOT NULL,
            exam_type    VARCHAR NOT NULL,
            exam_name    VARCHAR NOT NULL,
            score_weight INTEGER NOT NULL DEFAULT 0,
            source       VARCHAR DEFAULT 'calc',
            created_at   TIMESTAMP DEFAULT current_timestamp,
            PRIMARY KEY (date, exam_type, exam_name)
        )
    """)

    # 시퀀스 (forecast.id 자동증가)
    con.execute("""
        CREATE SEQUENCE IF NOT EXISTS forecast_id_seq START 1
    """)

    con.close()
    print('[ska-DB] 스키마 생성 완료')
    print('  - revenue_daily')
    print('  - environment_factors')
    print('  - exam_events')
    print('  - forecast')

if __name__ == '__main__':
    setup()
