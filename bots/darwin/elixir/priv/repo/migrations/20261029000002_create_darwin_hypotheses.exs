defmodule Darwin.Repo.Migrations.CreateDarwinHypotheses do
  use Ecto.Migration

  def change do
    create table(:darwin_hypotheses) do
      add :source_paper_id, :string, size: 100
      add :target_team, :string, size: 50
      add :target_module, :string, size: 200
      add :hypothesis_text, :text, null: false
      add :expected_metric, :string, size: 100
      add :expected_delta, :decimal, precision: 8, scale: 3
      add :confidence, :decimal, precision: 4, scale: 3
      add :status, :string, size: 20, null: false, default: "pending"
      add :test_result, :map
      add :measured_at, :utc_datetime
      timestamps(updated_at: false)
    end

    create index(:darwin_hypotheses, [:status])
    create index(:darwin_hypotheses, [:target_team])
    create index(:darwin_hypotheses, [:source_paper_id])
    create index(:darwin_hypotheses, [:inserted_at])
  end
end
