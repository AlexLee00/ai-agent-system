defmodule TeamJay.Repo.Migrations.SigmaDashboardViews do
  use Ecto.Migration

  def up do
    execute("""
    CREATE MATERIALIZED VIEW IF NOT EXISTS sigma_pod_performance_dashboard AS
    SELECT
      DATE_TRUNC('day', inserted_at) AS day,
      pod_name,
      COUNT(*) AS total_cycles,
      AVG(score) AS avg_score,
      COUNT(*) FILTER (WHERE category = 'preferred') AS preferred_count,
      COUNT(*) FILTER (WHERE category = 'rejected') AS rejected_count,
      AVG(
        CASE WHEN metrics->>'success_count' IS NOT NULL
          THEN (metrics->>'success_count')::float /
               NULLIF((metrics->>'success_count')::float + (metrics->>'error_count')::float, 0)
          ELSE NULL
        END
      ) AS avg_accuracy
    FROM sigma_dpo_preference_pairs
    WHERE inserted_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE_TRUNC('day', inserted_at), pod_name
    ORDER BY day DESC, avg_score DESC
    """)

    execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sigma_dashboard_day_pod
      ON sigma_pod_performance_dashboard (day, pod_name)
    """)

    execute("""
    CREATE MATERIALIZED VIEW IF NOT EXISTS sigma_directive_effectiveness AS
    SELECT
      team AS target_team,
      DATE_TRUNC('week', executed_at) AS week,
      COUNT(*) AS total_directives,
      COUNT(*) FILTER (WHERE outcome = 'success') AS applied_count,
      COUNT(*) FILTER (WHERE outcome = 'failure') AS rejected_count,
      COUNT(*) FILTER (WHERE outcome = 'success')::float /
        NULLIF(COUNT(*), 0) AS effectiveness_score
    FROM sigma_v2_directive_audit
    WHERE executed_at > NOW() - INTERVAL '90 days'
    GROUP BY team, DATE_TRUNC('week', executed_at)
    ORDER BY week DESC
    """)

    execute("""
    CREATE INDEX IF NOT EXISTS idx_sigma_directive_eff_team
      ON sigma_directive_effectiveness (target_team, week DESC)
    """)
  end

  def down do
    execute("DROP MATERIALIZED VIEW IF EXISTS sigma_directive_effectiveness")
    execute("DROP MATERIALIZED VIEW IF EXISTS sigma_pod_performance_dashboard")
  end
end
