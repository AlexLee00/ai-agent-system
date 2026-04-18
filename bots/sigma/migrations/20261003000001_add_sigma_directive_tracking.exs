defmodule TeamJay.Repo.Migrations.AddSigmaDirectiveTracking do
  use Ecto.Migration

  def change do
    create table(:sigma_directive_tracking) do
      add :cycle_id, :string, null: false
      add :team, :string, null: false
      add :feedback_type, :string
      add :issued_status, :string
      add :issued_at, :utc_datetime_usec
      add :fulfilled_at, :utc_datetime_usec
      timestamps(inserted_at: :created_at, updated_at: false)
    end

    create index(:sigma_directive_tracking, [:cycle_id, :team])
    create index(:sigma_directive_tracking, [:team, :issued_at])
    create index(:sigma_directive_tracking, [:fulfilled_at])
  end
end
