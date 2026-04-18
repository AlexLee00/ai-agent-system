defmodule TeamJay.Repo.Migrations.AddSigmaPodPerformance do
  use Ecto.Migration

  def change do
    create table(:sigma_pod_performance) do
      add :pod_name, :string, null: false
      add :team, :string
      add :directive_id, :string
      add :success, :boolean, default: false
      add :accuracy, :float
      add :evaluated_at, :utc_datetime_usec
      timestamps(inserted_at: :created_at, updated_at: false)
    end

    create index(:sigma_pod_performance, [:pod_name, :evaluated_at])
    create index(:sigma_pod_performance, [:team, :success])
  end
end
