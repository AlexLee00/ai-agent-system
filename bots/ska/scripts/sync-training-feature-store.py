"""
ska training feature store backfill/sync

실행:
  bots/ska/venv/bin/python bots/ska/scripts/sync-training-feature-store.py --days=365
"""
import os
import sys
import psycopg2
from datetime import date as date_type

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))

from bots.ska.lib.feature_store import ensure_training_feature_table, sync_training_feature_store

PG_SKA = "dbname=jay options='-c search_path=ska,public'"


def parse_days():
    for arg in sys.argv[1:]:
        if arg.startswith('--days='):
            try:
                return int(arg.split('=', 1)[1])
            except ValueError:
                pass
    return 365


def parse_end_date():
    for arg in sys.argv[1:]:
        if arg.startswith('--end-date='):
            value = arg.split('=', 1)[1]
            try:
                return date_type.fromisoformat(value)
            except ValueError:
                raise SystemExit(f'잘못된 --end-date 형식: {value} (예: 2025-12-31)')
    return None


def main():
    days = parse_days()
    end_date = parse_end_date()
    con = psycopg2.connect(PG_SKA)
    try:
        ensure_training_feature_table(con)
        synced = sync_training_feature_store(con, days=days, end_date=end_date)
        if end_date:
            print(f'[FEATURE-STORE] ✅ training_feature_daily 동기화 완료 ({synced}행 대상, 기준일 {end_date}, 최근 {days}일)')
        else:
            print(f'[FEATURE-STORE] ✅ training_feature_daily 동기화 완료 ({synced}행 대상, 최근 {days}일)')
    finally:
        con.close()


if __name__ == '__main__':
    main()
