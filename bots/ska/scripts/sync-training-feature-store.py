"""
ska training feature store backfill/sync

실행:
  bots/ska/venv/bin/python bots/ska/scripts/sync-training-feature-store.py --days=365
"""
import os
import sys
import psycopg2

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


def main():
    days = parse_days()
    con = psycopg2.connect(PG_SKA)
    try:
        ensure_training_feature_table(con)
        synced = sync_training_feature_store(con, days=days)
        print(f'[FEATURE-STORE] ✅ training_feature_daily 동기화 완료 ({synced}행 대상, 최근 {days}일)')
    finally:
        con.close()


if __name__ == '__main__':
    main()
