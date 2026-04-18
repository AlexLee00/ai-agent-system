defmodule TeamJay.Repo.Migrations.AddDarwinAutonomyDashboard do
  use Ecto.Migration

  def up do
    execute("""
    CREATE MATERIALIZED VIEW IF NOT EXISTS darwin_autonomy_dashboard AS
    SELECT
      DATE_TRUNC('day', inserted_at AT TIME ZONE 'UTC') AS day,
      COUNT(*) FILTER (WHERE status = 'success') AS success_cycles,
      COUNT(*) FILTER (WHERE status = 'failure') AS failure_cycles,
      COUNT(*) FILTER (WHERE stage = 'applied') AS applied_cycles,
      AVG(llm_cost_usd) AS avg_cost,
      AVG(duration_sec) AS avg_duration_sec,
      COUNT(DISTINCT paper_id) AS unique_papers
    FROM darwin_cycle_history
    WHERE inserted_at > NOW() - INTERVAL '30 days'
    GROUP BY DATE_TRUNC('day', inserted_at AT TIME ZONE 'UTC')
    ORDER BY day DESC
    """)

    execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS idx_darwin_autonomy_dashboard_day
    ON darwin_autonomy_dashboard (day)
    """)
  end

  def down do
    execute("DROP MATERIALIZED VIEW IF EXISTS darwin_autonomy_dashboard")
  end
end
