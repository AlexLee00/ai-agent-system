"""
ska legacy forecast table cleanup

목적:
  - ska.forecast, ska.forecast_accuracy legacy 테이블을 안전하게 정리
  - 기본은 dry-run
  - --apply가 있어야 archive + drop 수행

절차:
  1. 존재 여부/행 수 확인
  2. archive 테이블 생성
  3. row count 검증
  4. 원본 legacy table drop

실행:
  dry-run:
    bots/ska/venv/bin/python bots/ska/scripts/cleanup-legacy-forecast-tables.py

  apply:
    bots/ska/venv/bin/python bots/ska/scripts/cleanup-legacy-forecast-tables.py --apply
"""
import datetime as dt
import os
import sys
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))

PG_SKA = "dbname=jay options='-c search_path=ska,public'"
LEGACY_TABLES = ("forecast", "forecast_accuracy")


def has_apply_flag():
    return "--apply" in sys.argv[1:]


def table_exists(cur, table_name):
    cur.execute(
        """
        SELECT EXISTS (
          SELECT 1
            FROM information_schema.tables
           WHERE table_schema = 'ska'
             AND table_name = %s
        )
        """,
        (table_name,),
    )
    return bool(cur.fetchone()[0])


def get_row_count(cur, table_name):
    cur.execute(f"SELECT COUNT(*)::bigint FROM ska.{table_name}")
    return int(cur.fetchone()[0] or 0)


def build_archive_name(table_name):
    suffix = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{table_name}_legacy_archive_{suffix}"


def print_plan(cur):
    print("[ska legacy cleanup plan]")
    for table_name in LEGACY_TABLES:
        if table_exists(cur, table_name):
            print(f"- ska.{table_name}: {get_row_count(cur, table_name)}행 -> archive 후 drop 대상")
        else:
            print(f"- ska.{table_name}: 없음")


def archive_and_drop_table(cur, table_name):
    if not table_exists(cur, table_name):
        return {"table": table_name, "skipped": True}

    source_count = get_row_count(cur, table_name)
    archive_name = build_archive_name(table_name)

    cur.execute(
        f"""
        CREATE TABLE ska.{archive_name} AS
        SELECT *
          FROM ska.{table_name}
        """
    )
    archive_count = get_row_count(cur, archive_name)
    if archive_count != source_count:
        raise RuntimeError(
            f"{table_name} archive row mismatch: source={source_count}, archive={archive_count}"
        )

    cur.execute(f"DROP TABLE ska.{table_name}")

    return {
        "table": table_name,
        "archive": archive_name,
        "source_count": source_count,
        "archive_count": archive_count,
        "skipped": False,
    }


def main():
    apply = has_apply_flag()
    con = psycopg2.connect(PG_SKA)
    try:
        cur = con.cursor()
        print_plan(cur)

        if not apply:
            print("\n[dry-run]")
            print("- 실제 변경 없음")
            print("- 적용하려면 --apply 필요")
            return

        print("\n[apply]")
        results = []
        for table_name in LEGACY_TABLES:
            results.append(archive_and_drop_table(cur, table_name))

        con.commit()

        for result in results:
            if result["skipped"]:
                print(f"- ska.{result['table']}: 없음, skip")
                continue
            print(
                f"- ska.{result['table']} -> ska.{result['archive']} "
                f"(rows={result['archive_count']}) archive 후 drop 완료"
            )
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


if __name__ == "__main__":
    main()
