defmodule TeamJay.Repo.Migrations.CreateSigmaV2LlmRoutingLog do
  use Ecto.Migration

  def up do
    execute """
    CREATE TABLE IF NOT EXISTS sigma_v2_llm_routing_log (
      id                 BIGSERIAL PRIMARY KEY,
      agent_name         TEXT NOT NULL,
      model_primary      TEXT NOT NULL,
      model_used         TEXT,
      fallback_used      BOOLEAN NOT NULL DEFAULT false,
      prompt_tokens      INTEGER,
      response_tokens    INTEGER,
      latency_ms         INTEGER,
      cost_usd           DOUBLE PRECISION,
      response_ok        BOOLEAN NOT NULL DEFAULT false,
      error_reason       TEXT,
      urgency            TEXT NOT NULL DEFAULT 'medium',
      task_type          TEXT NOT NULL DEFAULT 'unknown',
      budget_ratio       DOUBLE PRECISION,
      recommended_reason TEXT,
      provider           TEXT NOT NULL DEFAULT 'direct_anthropic',
      inserted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """

    execute "CREATE INDEX IF NOT EXISTS idx_sigma_v2_routing_log_agent      ON sigma_v2_llm_routing_log (agent_name)"
    execute "CREATE INDEX IF NOT EXISTS idx_sigma_v2_routing_log_inserted_at ON sigma_v2_llm_routing_log (inserted_at DESC)"
    execute "CREATE INDEX IF NOT EXISTS idx_sigma_v2_routing_log_provider    ON sigma_v2_llm_routing_log (provider)"
    execute "CREATE INDEX IF NOT EXISTS idx_sigma_v2_routing_log_response_ok ON sigma_v2_llm_routing_log (response_ok)"
  end

  def down do
    execute "DROP TABLE IF EXISTS sigma_v2_llm_routing_log"
  end
end
