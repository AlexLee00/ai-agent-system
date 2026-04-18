defmodule Darwin.Repo.Migrations.AddProviderToDarwinRoutingLog do
  use Ecto.Migration

  def up do
    execute "ALTER TABLE darwin_v2_llm_routing_log ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'direct_anthropic'"
    execute "CREATE INDEX IF NOT EXISTS idx_darwin_routing_log_provider ON darwin_v2_llm_routing_log (provider)"
  end

  def down do
    execute "DROP INDEX IF EXISTS idx_darwin_routing_log_provider"
    execute "ALTER TABLE darwin_v2_llm_routing_log DROP COLUMN IF EXISTS provider"
  end
end
