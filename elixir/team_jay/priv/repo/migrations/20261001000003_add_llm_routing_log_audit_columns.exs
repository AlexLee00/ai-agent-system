defmodule TeamJay.Repo.Migrations.AddLlmRoutingLogAuditColumns do
  use Ecto.Migration

  def up do
    execute "ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS prompt_hash TEXT"
    execute "ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS system_prompt_hash TEXT"
    execute "ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS request_fingerprint TEXT"
    execute "ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS prompt_chars INTEGER"

    execute """
    CREATE INDEX IF NOT EXISTS idx_llm_routing_log_prompt_hash
      ON llm_routing_log (prompt_hash, created_at DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_llm_routing_log_request_fingerprint
      ON llm_routing_log (request_fingerprint, created_at DESC)
    """
  end

  def down do
    execute "DROP INDEX IF EXISTS idx_llm_routing_log_request_fingerprint"
    execute "DROP INDEX IF EXISTS idx_llm_routing_log_prompt_hash"
    execute "ALTER TABLE llm_routing_log DROP COLUMN IF EXISTS prompt_chars"
    execute "ALTER TABLE llm_routing_log DROP COLUMN IF EXISTS request_fingerprint"
    execute "ALTER TABLE llm_routing_log DROP COLUMN IF EXISTS system_prompt_hash"
    execute "ALTER TABLE llm_routing_log DROP COLUMN IF EXISTS prompt_hash"
  end
end
