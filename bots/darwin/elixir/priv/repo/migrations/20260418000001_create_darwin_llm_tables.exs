defmodule Darwin.Repo.Migrations.CreateDarwinLlmTables do
  use Ecto.Migration

  def change do
    create table(:darwin_v2_llm_routing_log) do
      add :agent_role, :string, size: 50, null: false
      add :model_used, :string, size: 80, null: false
      add :prompt_tokens, :integer
      add :completion_tokens, :integer
      add :latency_ms, :integer
      add :cost_usd, :decimal, precision: 10, scale: 4
      add :response_ok, :boolean, null: false, default: false
      add :error_message, :text
      add :request_dimensions, :map
      timestamps(updated_at: false)
    end

    create index(:darwin_v2_llm_routing_log, [:inserted_at])
    create index(:darwin_v2_llm_routing_log, [:agent_role])

    create table(:darwin_llm_cost_tracking) do
      add :call_date, :date, null: false
      add :agent_role, :string, size: 50, null: false
      add :model_used, :string, size: 80, null: false
      add :prompt_tokens, :integer, null: false, default: 0
      add :completion_tokens, :integer, null: false, default: 0
      add :cost_usd, :decimal, precision: 10, scale: 4, null: false, default: 0.0
      timestamps(updated_at: false)
    end

    create index(:darwin_llm_cost_tracking, [:call_date])
  end
end
