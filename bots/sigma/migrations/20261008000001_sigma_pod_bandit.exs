defmodule TeamJay.Repo.Migrations.SigmaPodBandit do
  use Ecto.Migration

  def change do
    create table(:sigma_pod_bandit_stats) do
      add :pod_name, :string, null: false
      add :target_team, :string, null: false
      add :trials, :integer, default: 0
      add :successes, :integer, default: 0
      add :failures, :integer, default: 0
      add :total_reward, :float, default: 0.0
      add :avg_reward, :float, default: 0.5
      add :last_selection_at, :utc_datetime_usec
      timestamps(inserted_at: :created_at, updated_at: :updated_at)
    end

    create unique_index(:sigma_pod_bandit_stats, [:pod_name, :target_team])
    create index(:sigma_pod_bandit_stats, [:avg_reward])

    create table(:sigma_pod_selection_log) do
      add :pod_name, :string, null: false
      add :target_team, :string, null: false
      add :strategy, :string, null: false
      add :context, :map
      add :selected_score, :float
      add :actual_reward, :float
      add :feedback_received_at, :utc_datetime_usec
      add :selected_at, :utc_datetime_usec, default: fragment("NOW()")
    end

    create index(:sigma_pod_selection_log, [:pod_name, :selected_at])
    create index(:sigma_pod_selection_log, [:strategy])
    create index(:sigma_pod_selection_log, [:target_team, :selected_at])
  end
end
