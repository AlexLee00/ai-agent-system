defmodule TeamJay.Repo.Migrations.AddDarwinV2LlmTracking do
  use Ecto.Migration

  def up do
    # LLM 비용 추적
    create table(:darwin_v2_llm_cost_tracking) do
      add :timestamp,    :utc_datetime_usec, null: false
      add :agent,        :string,            null: false
      add :model,        :string,            null: false
      add :provider,     :string,            null: false, default: "anthropic"
      add :tokens_in,    :integer,           null: false, default: 0
      add :tokens_out,   :integer,           null: false, default: 0
      add :cost_usd,     :float,             null: false, default: 0.0
      timestamps()
    end

    create index(:darwin_v2_llm_cost_tracking, [:timestamp])
    create index(:darwin_v2_llm_cost_tracking, [:agent])

    # LLM 라우팅 로그
    create table(:darwin_v2_llm_routing_log) do
      add :agent_name,        :string,  null: false
      add :model_primary,     :string,  null: false
      add :model_used,        :string
      add :fallback_used,     :boolean, default: false
      add :prompt_tokens,     :integer
      add :response_tokens,   :integer
      add :latency_ms,        :integer
      add :cost_usd,          :float
      add :response_ok,       :boolean, null: false, default: true
      add :error_reason,      :string
      add :urgency,           :string,  default: "medium"
      add :task_type,         :string,  default: "unknown"
      add :budget_ratio,      :float
      add :inserted_at,       :utc_datetime_usec, null: false
    end

    create index(:darwin_v2_llm_routing_log, [:agent_name])
    create index(:darwin_v2_llm_routing_log, [:inserted_at])
    create index(:darwin_v2_llm_routing_log, [:response_ok])
  end

  def down do
    drop table(:darwin_v2_llm_cost_tracking)
    drop table(:darwin_v2_llm_routing_log)
  end
end
