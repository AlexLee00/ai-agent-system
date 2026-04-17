defmodule TeamJay.Repo.Migrations.AddSigmaLlmCostTracking do
  use Ecto.Migration

  def change do
    create table(:sigma_llm_cost_tracking) do
      add :timestamp,  :utc_datetime_usec, null: false
      add :agent,      :string,            null: false   # 'commander', 'pod.risk', etc.
      add :model,      :string,            null: false
      add :provider,   :string,            null: false   # 'anthropic', 'ollama'
      add :tokens_in,  :integer,           null: false
      add :tokens_out, :integer,           null: false
      add :cost_usd,   :float,             null: false, default: 0.0

      timestamps()
    end

    create index(:sigma_llm_cost_tracking, [:timestamp])
    create index(:sigma_llm_cost_tracking, [:agent, :timestamp])
    create index(:sigma_llm_cost_tracking, [:model, :timestamp])
  end
end
