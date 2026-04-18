defmodule Jay.Core.Repo.Migrations.SkaSkillTables do
  use Ecto.Migration

  def up do
    execute """
    CREATE TABLE IF NOT EXISTS ska_skill_execution_log (
      id BIGSERIAL PRIMARY KEY,
      skill_name TEXT NOT NULL,
      caller_agent TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      error_reason TEXT,
      input_summary JSONB,
      output_summary JSONB,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_skill_exec_name
      ON ska_skill_execution_log(skill_name, inserted_at DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_skill_exec_caller
      ON ska_skill_execution_log(caller_agent, inserted_at DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_skill_exec_status
      ON ska_skill_execution_log(status)
    """

    execute """
    CREATE TABLE IF NOT EXISTS ska_cycle_metrics (
      id BIGSERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      duration_ms INTEGER,
      items_processed INTEGER,
      metadata JSONB,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_ska_cycle_agent_time
      ON ska_cycle_metrics(agent, inserted_at DESC)
    """

    execute """
    CREATE MATERIALIZED VIEW IF NOT EXISTS ska_skill_performance_24h AS
    SELECT
      skill_name,
      caller_agent,
      COUNT(*) AS total_executions,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
      ROUND(AVG(duration_ms)::numeric, 2) AS avg_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms
    FROM ska_skill_execution_log
    WHERE inserted_at > NOW() - INTERVAL '24 hours'
    GROUP BY skill_name, caller_agent
    """

    execute """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ska_skill_perf_skill_agent
      ON ska_skill_performance_24h (skill_name, caller_agent)
    """
  end

  def down do
    execute "DROP MATERIALIZED VIEW IF EXISTS ska_skill_performance_24h"
    execute "DROP TABLE IF EXISTS ska_cycle_metrics"
    execute "DROP TABLE IF EXISTS ska_skill_execution_log"
  end
end
