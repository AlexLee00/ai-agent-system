defmodule TeamJay.Repo.Migrations.AddSigmaV2Mailbox do
  use Ecto.Migration

  def change do
    create table(:sigma_v2_mailbox) do
      add :directive_id, :uuid
      add :tier, :integer
      add :team, :string
      add :action, :map
      add :status, :string, default: "pending"
      add :enqueued_at, :utc_datetime_usec
      add :resolved_at, :utc_datetime_usec
      add :master_decision, :string
      timestamps()
    end

    create index(:sigma_v2_mailbox, [:status, :enqueued_at])
    create index(:sigma_v2_mailbox, [:directive_id])
  end
end
