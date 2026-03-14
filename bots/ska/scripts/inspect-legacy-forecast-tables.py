"""
ska legacy forecast table inspection

목적:
  - legacy 테이블(forecast, forecast_accuracy)의 잔존 상태를 안전하게 확인
  - forecast_results 전환이 충분한지 dry-run으로 비교
  - 절대 DROP 하지 않음

실행:
  bots/ska/venv/bin/python bots/ska/scripts/inspect-legacy-forecast-tables.py
"""
import os
import sys
import psycopg2

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../..'))

PG_SKA = "dbname=jay options='-c search_path=ska,public'"


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


def resolve_date_column(cur, table_name, candidates):
    cur.execute(
        """
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'ska'
           AND table_name = %s
        """,
        (table_name,),
    )
    columns = {row[0] for row in cur.fetchall()}
    for candidate in candidates:
        if candidate in columns:
            return candidate
    return None


def get_basic_stats(cur, table_name, date_expr):
    cur.execute(
        f"""
        SELECT COUNT(*)::bigint,
               MIN({date_expr})::text,
               MAX({date_expr})::text
          FROM ska.{table_name}
        """
    )
    count, min_date, max_date = cur.fetchone()
    return {
        "count": int(count or 0),
        "min_date": min_date,
        "max_date": max_date,
    }


def get_forecast_results_stats(cur):
    cur.execute(
        """
        SELECT COUNT(*)::bigint,
               MIN(forecast_date)::text,
               MAX(forecast_date)::text,
               COUNT(*) FILTER (WHERE predictions IS NOT NULL)::bigint
          FROM ska.forecast_results
        """
    )
    count, min_date, max_date, populated = cur.fetchone()
    return {
        "count": int(count or 0),
        "min_date": min_date,
        "max_date": max_date,
        "populated_predictions": int(populated or 0),
    }


def get_overlap_count(cur, source_table, source_date_expr, target_table, target_date_expr):
    cur.execute(
        f"""
        SELECT COUNT(*)::bigint
          FROM (
                SELECT DISTINCT {source_date_expr} AS dt
                  FROM ska.{source_table}
                 WHERE {source_date_expr} IS NOT NULL
               ) s
          JOIN (
                SELECT DISTINCT {target_date_expr} AS dt
                  FROM ska.{target_table}
                 WHERE {target_date_expr} IS NOT NULL
               ) t
            ON s.dt = t.dt
        """
    )
    return int(cur.fetchone()[0] or 0)


def print_table_report(label, exists, stats=None, extras=None):
    if not exists:
        print(f"- {label}: 없음")
        return

    stats = stats or {}
    extras = extras or {}
    line = (
        f"- {label}: {stats.get('count', 0)}행"
        f" | 범위 {stats.get('min_date') or '-'} ~ {stats.get('max_date') or '-'}"
    )
    if extras:
        extra_bits = [f"{key}={value}" for key, value in extras.items()]
        line += " | " + " ".join(extra_bits)
    print(line)


def print_recommendation(forecast_exists, forecast_stats, accuracy_exists, accuracy_stats, results_stats):
    print("\n[판단]")
    if results_stats["count"] == 0:
        print("- forecast_results가 비어 있어 legacy 테이블 정리 금지")
        return

    if forecast_exists and forecast_stats["count"] > 0:
        print("- forecast 테이블 데이터가 남아 있습니다. 바로 삭제하지 말고 date overlap을 확인 후 archive/drop 판단")
    else:
        print("- forecast 테이블은 runtime 기준 비필수로 보입니다")

    if accuracy_exists and accuracy_stats["count"] > 0:
        print("- forecast_accuracy 데이터가 남아 있습니다. 정확도는 이미 forecast_results + revenue_daily로 계산되므로 archive 후보입니다")
    else:
        print("- forecast_accuracy는 legacy 잔존물 수준으로 보입니다")

    print("- 이 스크립트는 점검 전용입니다. 실제 DROP은 별도 승인 후 진행해야 합니다")


def main():
    con = psycopg2.connect(PG_SKA)
    try:
        cur = con.cursor()

        forecast_exists = table_exists(cur, "forecast")
        accuracy_exists = table_exists(cur, "forecast_accuracy")
        results_exists = table_exists(cur, "forecast_results")
        revenue_exists = table_exists(cur, "revenue_daily")

        print("[ska legacy table inspection]")
        print_table_report(
            "forecast_results",
            results_exists,
            get_forecast_results_stats(cur) if results_exists else None,
            extras={
                "predictions_filled": get_forecast_results_stats(cur)["populated_predictions"]
            } if results_exists else None,
        )
        print_table_report(
            "revenue_daily",
            revenue_exists,
            get_basic_stats(cur, "revenue_daily", "date") if revenue_exists else None,
        )

        forecast_date_col = (
            resolve_date_column(cur, "forecast", ["forecast_date", "date", "target_date"])
            if forecast_exists else None
        )
        accuracy_date_col = (
            resolve_date_column(cur, "forecast_accuracy", ["date", "forecast_date", "target_date"])
            if accuracy_exists else None
        )

        forecast_stats = (
            get_basic_stats(cur, "forecast", forecast_date_col)
            if forecast_exists and forecast_date_col else {"count": 0, "min_date": None, "max_date": None}
        )
        accuracy_stats = (
            get_basic_stats(cur, "forecast_accuracy", accuracy_date_col)
            if accuracy_exists and accuracy_date_col else {"count": 0, "min_date": None, "max_date": None}
        )
        results_stats = get_forecast_results_stats(cur) if results_exists else {"count": 0}

        forecast_extras = {}
        if forecast_exists and results_exists and forecast_date_col:
            forecast_extras["date_overlap_with_results"] = get_overlap_count(
                cur, "forecast", forecast_date_col, "forecast_results", "forecast_date"
            )
        if forecast_exists:
            forecast_extras["date_column"] = forecast_date_col or "unknown"
        print_table_report("forecast", forecast_exists, forecast_stats, forecast_extras)

        accuracy_extras = {}
        if accuracy_exists and results_exists and accuracy_date_col:
            accuracy_extras["date_overlap_with_results"] = get_overlap_count(
                cur, "forecast_accuracy", accuracy_date_col, "forecast_results", "forecast_date"
            )
        if accuracy_exists and revenue_exists and accuracy_date_col:
            accuracy_extras["date_overlap_with_actuals"] = get_overlap_count(
                cur, "forecast_accuracy", accuracy_date_col, "revenue_daily", "date"
            )
        if accuracy_exists:
            accuracy_extras["date_column"] = accuracy_date_col or "unknown"
        print_table_report("forecast_accuracy", accuracy_exists, accuracy_stats, accuracy_extras)

        print_recommendation(
            forecast_exists,
            forecast_stats,
            accuracy_exists,
            accuracy_stats,
            results_stats,
        )
    finally:
        con.close()


if __name__ == "__main__":
    main()
