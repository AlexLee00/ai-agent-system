defmodule TeamJay.Repo.Migrations.CreateAgentKvStore do
  use Ecto.Migration

  def up do
    execute("CREATE SCHEMA IF NOT EXISTS agent")

    execute("""
    CREATE TABLE IF NOT EXISTS agent.kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    """)

    execute(
      "CREATE INDEX IF NOT EXISTS idx_agent_kv_store_updated_at ON agent.kv_store(updated_at DESC)"
    )
  end

  def down do
    execute("DROP INDEX IF EXISTS agent.idx_agent_kv_store_updated_at")
    execute("DROP TABLE IF EXISTS agent.kv_store")
  end
end
