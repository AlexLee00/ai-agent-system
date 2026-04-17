defmodule TeamJay.Repo.Migrations.AddSigmaLlmRoutingLog do
  use Ecto.Migration

  def change do
    create table(:sigma_v2_llm_routing_log) do
      add :agent_name,        :string,         null: false
      add :model_primary,     :string,         null: false
      add :model_used,        :string,         null: true
      add :fallback_used,     :boolean,        default: false
      add :prompt_tokens,     :integer
      add :response_tokens,   :integer
      add :latency_ms,        :integer
      add :cost_usd,          :decimal,        precision: 10, scale: 6
      add :response_ok,       :boolean,        null: false
      add :error_reason,      :text
      add :urgency,           :string,         size: 16
      add :task_type,         :string,         size: 32
      add :budget_ratio,      :decimal,        precision: 5, scale: 4
      add :recommended_reason, :text

      timestamps(updated_at: false)
    end

    create index(:sigma_v2_llm_routing_log, [:agent_name, :inserted_at])
    create index(:sigma_v2_llm_routing_log, [:model_used, :response_ok])
  end
end
