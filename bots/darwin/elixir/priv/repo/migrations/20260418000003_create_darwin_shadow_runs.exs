defmodule Darwin.Repo.Migrations.CreateDarwinShadowRuns do
  use Ecto.Migration

  def change do
    create table(:darwin_v2_shadow_runs) do
      add :run_date, :date, null: false
      add :scan_result, :map
      add :evaluation, :map
      add :plan, :map
      add :v1_scan_result_id, :bigint
      add :match_score, :decimal, precision: 5, scale: 4
      timestamps()
    end

    create index(:darwin_v2_shadow_runs, [:run_date])
  end
end
