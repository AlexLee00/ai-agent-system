defmodule Jay.Core.Repo.Migrations.CreateLlmRoutingLog do
  use Ecto.Migration

  def up do
    execute """
    CREATE TABLE IF NOT EXISTS llm_routing_log (
      id              BIGSERIAL PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider        TEXT NOT NULL,
      agent           TEXT,
      caller_team     TEXT,
      abstract_model  TEXT NOT NULL,
      success         BOOLEAN NOT NULL,
      duration_ms     INTEGER,
      cost_usd        DOUBLE PRECISION DEFAULT 0,
      fallback_count  INTEGER DEFAULT 0,
      error           TEXT,
      session_id      TEXT
    )
    """

    execute "CREATE INDEX IF NOT EXISTS idx_llm_routing_log_created_at ON llm_routing_log (created_at DESC)"
    execute "CREATE INDEX IF NOT EXISTS idx_llm_routing_log_provider    ON llm_routing_log (provider)"
    execute "CREATE INDEX IF NOT EXISTS idx_llm_routing_log_agent       ON llm_routing_log (agent)"
  end

  def down do
    execute "DROP TABLE IF EXISTS llm_routing_log"
  end
end
