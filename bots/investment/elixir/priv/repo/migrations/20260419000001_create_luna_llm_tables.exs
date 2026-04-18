defmodule Luna.Repo.Migrations.CreateLunaLlmTables do
  use Ecto.Migration

  def change do
    create table(:luna_v2_llm_routing_log) do
      add :agent_name,         :string,  size: 100, null: false
      add :model_primary,      :string,  size: 80,  null: false
      add :model_used,         :string,  size: 80
      add :fallback_used,      :boolean, null: false, default: false
      add :prompt_tokens,      :integer
      add :response_tokens,    :integer
      add :latency_ms,         :integer
      add :cost_usd,           :decimal, precision: 10, scale: 6
      add :response_ok,        :boolean, null: false, default: false
      add :error_reason,       :string,  size: 200
      add :urgency,            :string,  size: 20
      add :task_type,          :string,  size: 50
      add :budget_ratio,       :float
      add :recommended_reason, :string,  size: 200
      add :provider,           :string,  size: 50
      add :inserted_at,        :utc_datetime, null: false
    end

    create index(:luna_v2_llm_routing_log, [:agent_name])
    create index(:luna_v2_llm_routing_log, [:inserted_at])

    create table(:luna_llm_cost_tracking) do
      add :timestamp,   :utc_datetime, null: false
      add :agent,       :string, size: 100, null: false
      add :model,       :string, size: 80,  null: false
      add :provider,    :string, size: 50
      add :tokens_in,   :integer, null: false, default: 0
      add :tokens_out,  :integer, null: false, default: 0
      add :cost_usd,    :decimal, precision: 10, scale: 6
      add :inserted_at, :utc_datetime, null: false
      add :updated_at,  :utc_datetime, null: false
    end

    create index(:luna_llm_cost_tracking, [:timestamp])
    create index(:luna_llm_cost_tracking, [:agent])
  end
end
