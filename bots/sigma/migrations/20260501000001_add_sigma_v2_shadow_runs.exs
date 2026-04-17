defmodule TeamJay.Repo.Migrations.AddSigmaV2ShadowRuns do
  use Ecto.Migration

  def change do
    create table(:sigma_v2_shadow_runs) do
      add :run_date, :date, null: false
      add :formation, :map
      add :analysis, :map
      add :v1_daily_run_id, :bigint
      add :match_score, :float
      timestamps()
    end

    create index(:sigma_v2_shadow_runs, [:run_date])
    create index(:sigma_v2_shadow_runs, [:v1_daily_run_id])
    create index(:sigma_v2_shadow_runs, [:run_date, :match_score])
  end
end
