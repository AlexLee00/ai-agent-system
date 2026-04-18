defmodule TeamJay.Repo.Migrations.SigmaPodPerformanceLog do
  use Ecto.Migration

  def change do
    create table(:sigma_pod_performance_log) do
      add :period_start, :utc_datetime_usec, null: false
      add :period_end, :utc_datetime_usec, null: false
      add :pod_name, :string, null: false
      add :target_team, :string
      add :total_cycles, :integer, default: 0
      add :preferred_count, :integer, default: 0
      add :rejected_count, :integer, default: 0
      add :avg_score, :float
      add :avg_accuracy, :float
      add :rank, :integer
      timestamps(inserted_at: :inserted_at, updated_at: false)
    end

    create index(:sigma_pod_performance_log, [:pod_name, :period_start])
    create index(:sigma_pod_performance_log, [:inserted_at])
  end
end
