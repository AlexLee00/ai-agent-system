defmodule TeamJay.Repo.Migrations.AddDarwinReflexionMemory do
  use Ecto.Migration

  def change do
    create table(:darwin_v2_reflexion_memory) do
      add :stage, :string, size: 30, null: false
      add :failure_type, :string, size: 50
      add :reflection_text, :text
      add :paper_id, :string, size: 80
      add :outcome_improved, :boolean
      timestamps(updated_at: false)
    end

    create index(:darwin_v2_reflexion_memory, [:stage])
    create index(:darwin_v2_reflexion_memory, [:inserted_at])
  end
end
