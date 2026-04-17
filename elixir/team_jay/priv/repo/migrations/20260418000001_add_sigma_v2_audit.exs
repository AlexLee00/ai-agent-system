defmodule TeamJay.Repo.Migrations.AddSigmaV2Audit do
  use Ecto.Migration

  def change do
    create table(:sigma_v2_directive_audit) do
      add :directive_id, :uuid
      add :tier, :integer
      add :team, :string
      add :action, :map
      add :principle_check_result, :map
      add :executed_at, :utc_datetime_usec
      add :outcome, :string
      add :rollback_spec, :map
      timestamps()
    end

    create index(:sigma_v2_directive_audit, [:team, :executed_at])
    create index(:sigma_v2_directive_audit, [:tier, :outcome])
  end
end
