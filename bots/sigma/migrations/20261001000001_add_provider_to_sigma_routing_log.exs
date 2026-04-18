defmodule TeamJay.Repo.Migrations.AddProviderToSigmaRoutingLog do
  use Ecto.Migration

  def up do
    execute "ALTER TABLE sigma_v2_llm_routing_log ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'direct_anthropic'"
    execute "CREATE INDEX IF NOT EXISTS idx_sigma_routing_log_provider ON sigma_v2_llm_routing_log (provider)"
  end

  def down do
    execute "DROP INDEX IF EXISTS idx_sigma_routing_log_provider"
    execute "ALTER TABLE sigma_v2_llm_routing_log DROP COLUMN IF EXISTS provider"
  end
end
