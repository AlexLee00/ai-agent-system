"""
ska-001: PostgreSQL ska 스키마 생성
실행: bots/ska/venv/bin/python bots/ska/scripts/setup-db.py
"""
import psycopg2
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))

from bots.ska.lib.feature_store import ensure_training_feature_table

PG_SKA = "dbname=jay options='-c search_path=ska,public'"


def setup():
    print('[ska-DB] PostgreSQL ska 스키마 초기화')
    con = psycopg2.connect(PG_SKA)
    cur = con.cursor()

    # ska 스키마 생성
    cur.execute("CREATE SCHEMA IF NOT EXISTS ska")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS revenue_daily (
            date               DATE PRIMARY KEY,
            actual_revenue     INTEGER DEFAULT 0,
            occupancy_rate     DOUBLE PRECISION DEFAULT 0.0,
            total_reservations INTEGER DEFAULT 0,
            cancellation_count INTEGER DEFAULT 0,
            studyroom_revenue  INTEGER DEFAULT 0,
            general_revenue    INTEGER DEFAULT 0,
            updated_at         TIMESTAMP DEFAULT now()
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS environment_factors (
            date                DATE PRIMARY KEY,
            holiday_flag        BOOLEAN DEFAULT false,
            holiday_name        TEXT,
            rain_prob           DOUBLE PRECISION DEFAULT 0.0,
            temperature         DOUBLE PRECISION,
            exam_score          INTEGER DEFAULT 0,
            exam_types          TEXT,
            vacation_flag       BOOLEAN DEFAULT false,
            festival_flag       BOOLEAN DEFAULT false,
            festival_name       TEXT,
            factors_json        TEXT,
            bridge_holiday_flag BOOLEAN DEFAULT false,
            created_at          TIMESTAMP DEFAULT now(),
            updated_at          TIMESTAMP DEFAULT now()
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS forecast (
            id                SERIAL PRIMARY KEY,
            target_date       DATE NOT NULL,
            predicted_revenue INTEGER,
            base_forecast     INTEGER,
            env_score         DOUBLE PRECISION,
            yhat_lower        INTEGER,
            yhat_upper        INTEGER,
            confidence        DOUBLE PRECISION,
            model_version     TEXT DEFAULT 'baseline-v1',
            created_at        TIMESTAMP DEFAULT now()
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS exam_events (
            id           SERIAL PRIMARY KEY,
            date         DATE NOT NULL,
            exam_type    TEXT NOT NULL,
            exam_name    TEXT NOT NULL,
            score_weight INTEGER NOT NULL DEFAULT 0,
            source       TEXT DEFAULT 'calc',
            created_at   TIMESTAMP DEFAULT now(),
            UNIQUE (date, exam_type, exam_name)
        )
    """)

    ensure_training_feature_table(con)

    con.commit()
    cur.close()
    con.close()

    print('[ska-DB] 스키마 생성 완료')
    print('  - revenue_daily')
    print('  - environment_factors')
    print('  - forecast')
    print('  - exam_events')
    print('  - training_feature_daily')


if __name__ == '__main__':
    setup()
