defmodule TeamJay.Repo.Migrations.AddDarwinV2ShadowRuns do
  use Ecto.Migration

  def change do
    create table(:darwin_v2_shadow_runs) do
      add :paper_title, :string
      add :v2_score, :integer
      add :v1_score, :integer
      add :match_score, :float
      add :v1_result, :map
      add :v2_result, :map
      timestamps()
    end

    create index(:darwin_v2_shadow_runs, [:inserted_at])
  end
end
