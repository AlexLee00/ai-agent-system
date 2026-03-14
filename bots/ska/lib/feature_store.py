"""
ska feature store helpers

운영 테이블(revenue_daily, environment_factors, forecast_results, reservation.daily_summary)을
학습용 feature store(ska.training_feature_daily)로 동기화한다.
"""
import psycopg2

TRAINING_FEATURE_TABLE_SQL = """
    CREATE TABLE IF NOT EXISTS ska.training_feature_daily (
        date                         DATE PRIMARY KEY,
        target_revenue               INTEGER,
        total_amount                 INTEGER,
        pickko_total                 INTEGER,
        pickko_study_room            INTEGER,
        reservation_general_revenue  INTEGER,
        entries_count                INTEGER,
        occupancy_rate               DOUBLE PRECISION,
        total_reservations           INTEGER,
        cancellation_count           INTEGER,
        studyroom_revenue            INTEGER,
        ska_general_revenue          INTEGER,
        predicted_revenue            INTEGER,
        predicted_prophet            INTEGER,
        predicted_sarima             INTEGER,
        predicted_quick              INTEGER,
        yhat_lower                   INTEGER,
        yhat_upper                   INTEGER,
        forecast_reservation_count   INTEGER,
        model_version                TEXT,
        mape                         DOUBLE PRECISION,
        holiday_flag                 BOOLEAN DEFAULT false,
        holiday_name                 TEXT,
        rain_prob                    DOUBLE PRECISION,
        temperature                  DOUBLE PRECISION,
        exam_score                   INTEGER,
        exam_types                   TEXT,
        vacation_flag                BOOLEAN DEFAULT false,
        festival_flag                BOOLEAN DEFAULT false,
        festival_name                TEXT,
        bridge_holiday_flag          BOOLEAN DEFAULT false,
        weekday                      INTEGER,
        month                        INTEGER,
        day_of_month                 INTEGER,
        is_weekend                   BOOLEAN DEFAULT false,
        lag_revenue_1d               INTEGER,
        lag_revenue_7d               INTEGER,
        lag_revenue_14d              INTEGER,
        rolling_mean_7d              DOUBLE PRECISION,
        rolling_mean_14d             DOUBLE PRECISION,
        rolling_sum_7d               INTEGER,
        same_weekday_mean_4          DOUBLE PRECISION,
        revenue_mix_study_ratio      DOUBLE PRECISION,
        revenue_mix_general_ratio    DOUBLE PRECISION,
        forecast_error               INTEGER,
        forecast_abs_error           INTEGER,
        forecast_created_at          TIMESTAMPTZ,
        source_updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
"""


def ensure_training_feature_table(con):
    cur = con.cursor()
    cur.execute(TRAINING_FEATURE_TABLE_SQL)
    con.commit()
    cur.close()


def sync_training_feature_store(con, days=365):
    cur = con.cursor()
    cur.execute("""
        WITH date_span AS (
            SELECT generate_series(
                current_date - (%s::int - 1),
                current_date,
                INTERVAL '1 day'
            )::date AS date
        ),
        latest_forecasts AS (
            SELECT
                fr.forecast_date,
                fr.model_version,
                fr.predictions,
                fr.mape,
                fr.created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY fr.forecast_date
                    ORDER BY fr.created_at DESC, fr.id DESC
                ) AS rn
            FROM ska.forecast_results fr
            WHERE fr.forecast_date >= current_date - (%s::int - 1)
        ),
        merged AS (
            SELECT
                ds.date,
                rd.actual_revenue AS target_revenue,
                rds.total_amount,
                rds.pickko_total,
                rds.pickko_study_room,
                rds.general_revenue AS reservation_general_revenue,
                rds.entries_count,
                rd.occupancy_rate,
                rd.total_reservations,
                rd.cancellation_count,
                rd.studyroom_revenue,
                rd.general_revenue AS ska_general_revenue,
                (lf.predictions->>'yhat')::int AS predicted_revenue,
                (lf.predictions->>'yhat_prophet')::int AS predicted_prophet,
                (lf.predictions->>'yhat_sarima')::int AS predicted_sarima,
                (lf.predictions->>'yhat_quick')::int AS predicted_quick,
                (lf.predictions->>'yhat_lower')::int AS yhat_lower,
                (lf.predictions->>'yhat_upper')::int AS yhat_upper,
                (lf.predictions->>'reservation_count')::int AS forecast_reservation_count,
                lf.model_version,
                lf.mape,
                COALESCE(ef.holiday_flag, false) AS holiday_flag,
                ef.holiday_name,
                ef.rain_prob,
                ef.temperature,
                ef.exam_score,
                ef.exam_types,
                COALESCE(ef.vacation_flag, false) AS vacation_flag,
                COALESCE(ef.festival_flag, false) AS festival_flag,
                ef.festival_name,
                COALESCE(ef.bridge_holiday_flag, false) AS bridge_holiday_flag,
                EXTRACT(ISODOW FROM ds.date)::int AS weekday,
                EXTRACT(MONTH FROM ds.date)::int AS month,
                EXTRACT(DAY FROM ds.date)::int AS day_of_month,
                (EXTRACT(ISODOW FROM ds.date)::int >= 6) AS is_weekend,
                LAG(rd.actual_revenue, 1) OVER (ORDER BY ds.date) AS lag_revenue_1d,
                LAG(rd.actual_revenue, 7) OVER (ORDER BY ds.date) AS lag_revenue_7d,
                LAG(rd.actual_revenue, 14) OVER (ORDER BY ds.date) AS lag_revenue_14d,
                AVG(rd.actual_revenue) OVER (
                    ORDER BY ds.date
                    ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
                ) AS rolling_mean_7d,
                AVG(rd.actual_revenue) OVER (
                    ORDER BY ds.date
                    ROWS BETWEEN 14 PRECEDING AND 1 PRECEDING
                ) AS rolling_mean_14d,
                SUM(rd.actual_revenue) OVER (
                    ORDER BY ds.date
                    ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING
                ) AS rolling_sum_7d,
                AVG(rd.actual_revenue) OVER (
                    PARTITION BY EXTRACT(ISODOW FROM ds.date)
                    ORDER BY ds.date
                    ROWS BETWEEN 4 PRECEDING AND 1 PRECEDING
                ) AS same_weekday_mean_4,
                CASE
                    WHEN rd.actual_revenue > 0 THEN rd.studyroom_revenue::float / rd.actual_revenue
                    ELSE NULL
                END AS revenue_mix_study_ratio,
                CASE
                    WHEN rd.actual_revenue > 0 THEN rd.general_revenue::float / rd.actual_revenue
                    ELSE NULL
                END AS revenue_mix_general_ratio,
                CASE
                    WHEN rd.actual_revenue IS NOT NULL
                     AND (lf.predictions->>'yhat') IS NOT NULL
                    THEN rd.actual_revenue - (lf.predictions->>'yhat')::int
                    ELSE NULL
                END AS forecast_error,
                CASE
                    WHEN rd.actual_revenue IS NOT NULL
                     AND (lf.predictions->>'yhat') IS NOT NULL
                    THEN ABS(rd.actual_revenue - (lf.predictions->>'yhat')::int)
                    ELSE NULL
                END AS forecast_abs_error,
                lf.created_at AS forecast_created_at
            FROM date_span ds
            LEFT JOIN latest_forecasts lf
              ON lf.forecast_date = ds.date
             AND lf.rn = 1
            LEFT JOIN ska.environment_factors ef
              ON ef.date = ds.date
            LEFT JOIN ska.revenue_daily rd
              ON rd.date = ds.date
            LEFT JOIN reservation.daily_summary rds
              ON rds.date::date = ds.date
        )
        INSERT INTO ska.training_feature_daily (
            date, target_revenue, total_amount, pickko_total, pickko_study_room,
            reservation_general_revenue, entries_count, occupancy_rate, total_reservations,
            cancellation_count, studyroom_revenue, ska_general_revenue, predicted_revenue,
            predicted_prophet, predicted_sarima, predicted_quick, yhat_lower, yhat_upper,
            forecast_reservation_count, model_version, mape, holiday_flag, holiday_name,
            rain_prob, temperature, exam_score, exam_types, vacation_flag, festival_flag,
            festival_name, bridge_holiday_flag, weekday, month, day_of_month, is_weekend,
            lag_revenue_1d, lag_revenue_7d, lag_revenue_14d, rolling_mean_7d, rolling_mean_14d,
            rolling_sum_7d, same_weekday_mean_4, revenue_mix_study_ratio, revenue_mix_general_ratio,
            forecast_error, forecast_abs_error, forecast_created_at, source_updated_at
        )
        SELECT
            date, target_revenue, total_amount, pickko_total, pickko_study_room,
            reservation_general_revenue, entries_count, occupancy_rate, total_reservations,
            cancellation_count, studyroom_revenue, ska_general_revenue, predicted_revenue,
            predicted_prophet, predicted_sarima, predicted_quick, yhat_lower, yhat_upper,
            forecast_reservation_count, model_version, mape, holiday_flag, holiday_name,
            rain_prob, temperature, exam_score, exam_types, vacation_flag, festival_flag,
            festival_name, bridge_holiday_flag, weekday, month, day_of_month, is_weekend,
            lag_revenue_1d, lag_revenue_7d, lag_revenue_14d, rolling_mean_7d, rolling_mean_14d,
            rolling_sum_7d, same_weekday_mean_4, revenue_mix_study_ratio, revenue_mix_general_ratio,
            forecast_error, forecast_abs_error, forecast_created_at, NOW()
        FROM merged
        ON CONFLICT (date) DO UPDATE SET
            target_revenue = EXCLUDED.target_revenue,
            total_amount = EXCLUDED.total_amount,
            pickko_total = EXCLUDED.pickko_total,
            pickko_study_room = EXCLUDED.pickko_study_room,
            reservation_general_revenue = EXCLUDED.reservation_general_revenue,
            entries_count = EXCLUDED.entries_count,
            occupancy_rate = EXCLUDED.occupancy_rate,
            total_reservations = EXCLUDED.total_reservations,
            cancellation_count = EXCLUDED.cancellation_count,
            studyroom_revenue = EXCLUDED.studyroom_revenue,
            ska_general_revenue = EXCLUDED.ska_general_revenue,
            predicted_revenue = EXCLUDED.predicted_revenue,
            predicted_prophet = EXCLUDED.predicted_prophet,
            predicted_sarima = EXCLUDED.predicted_sarima,
            predicted_quick = EXCLUDED.predicted_quick,
            yhat_lower = EXCLUDED.yhat_lower,
            yhat_upper = EXCLUDED.yhat_upper,
            forecast_reservation_count = EXCLUDED.forecast_reservation_count,
            model_version = EXCLUDED.model_version,
            mape = EXCLUDED.mape,
            holiday_flag = EXCLUDED.holiday_flag,
            holiday_name = EXCLUDED.holiday_name,
            rain_prob = EXCLUDED.rain_prob,
            temperature = EXCLUDED.temperature,
            exam_score = EXCLUDED.exam_score,
            exam_types = EXCLUDED.exam_types,
            vacation_flag = EXCLUDED.vacation_flag,
            festival_flag = EXCLUDED.festival_flag,
            festival_name = EXCLUDED.festival_name,
            bridge_holiday_flag = EXCLUDED.bridge_holiday_flag,
            weekday = EXCLUDED.weekday,
            month = EXCLUDED.month,
            day_of_month = EXCLUDED.day_of_month,
            is_weekend = EXCLUDED.is_weekend,
            lag_revenue_1d = EXCLUDED.lag_revenue_1d,
            lag_revenue_7d = EXCLUDED.lag_revenue_7d,
            lag_revenue_14d = EXCLUDED.lag_revenue_14d,
            rolling_mean_7d = EXCLUDED.rolling_mean_7d,
            rolling_mean_14d = EXCLUDED.rolling_mean_14d,
            rolling_sum_7d = EXCLUDED.rolling_sum_7d,
            same_weekday_mean_4 = EXCLUDED.same_weekday_mean_4,
            revenue_mix_study_ratio = EXCLUDED.revenue_mix_study_ratio,
            revenue_mix_general_ratio = EXCLUDED.revenue_mix_general_ratio,
            forecast_error = EXCLUDED.forecast_error,
            forecast_abs_error = EXCLUDED.forecast_abs_error,
            forecast_created_at = EXCLUDED.forecast_created_at,
            source_updated_at = NOW()
    """, (days, days))
    rowcount = cur.rowcount
    con.commit()
    cur.close()
    return rowcount
