defmodule TeamJay.Repo.Migrations.AddDarwinLlmCostTracking do
  use Ecto.Migration

  def change do
    create table(:darwin_llm_cost_tracking) do
      add :agent, :string
      add :model, :string
      add :provider, :string
      add :tokens_in, :integer
      add :tokens_out, :integer
      add :cost_usd, :float
      add :logged_at, :utc_datetime_usec
      timestamps()
    end

    create index(:darwin_llm_cost_tracking, [:agent, :logged_at])
    create index(:darwin_llm_cost_tracking, [:model, :logged_at])
  end
end
