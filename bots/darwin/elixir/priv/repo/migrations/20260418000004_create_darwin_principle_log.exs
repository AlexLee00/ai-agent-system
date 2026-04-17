defmodule Darwin.Repo.Migrations.CreateDarwinPrincipleLog do
  use Ecto.Migration

  def change do
    create table(:darwin_v2_principle_violations) do
      add :action, :string, size: 100, null: false
      add :principle_id, :string, size: 20
      add :description, :text
      add :phase, :string, size: 30
      add :paper_id, :string, size: 80
      add :blocked, :boolean, null: false, default: true
      add :context, :map
      timestamps(updated_at: false)
    end

    create index(:darwin_v2_principle_violations, [:inserted_at])
  end
end
