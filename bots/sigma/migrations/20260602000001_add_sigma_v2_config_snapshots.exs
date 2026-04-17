defmodule TeamJay.Repo.Migrations.AddSigmaV2ConfigSnapshots do
  use Ecto.Migration

  def change do
    create table(:sigma_v2_config_snapshots, primary_key: false) do
      add :id, :uuid, primary_key: true
      add :team, :string, null: false
      add :content, :text, null: false
      add :created_at, :utc_datetime_usec, null: false
    end

    create index(:sigma_v2_config_snapshots, [:team, :created_at])
  end
end
