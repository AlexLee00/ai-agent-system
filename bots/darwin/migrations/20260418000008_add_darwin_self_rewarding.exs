defmodule TeamJay.Repo.Migrations.AddDarwinSelfRewarding do
  use Ecto.Migration

  def change do
    create table(:darwin_dpo_preference_pairs) do
      add :cycle_id, :string, size: 100, null: false
      add :paper_title, :text
      add :stage, :string, size: 50
      add :metrics, :map, null: false
      add :score, :decimal, precision: 3, scale: 2, null: false
      add :critique, :text
      add :improvements, {:array, :text}, default: []
      add :category, :string, size: 20, null: false
      timestamps(updated_at: false)
    end

    create index(:darwin_dpo_preference_pairs, [:cycle_id])
    create index(:darwin_dpo_preference_pairs, [:category, :score])
    create index(:darwin_dpo_preference_pairs, [:inserted_at])

    create table(:darwin_recommender_history) do
      add :agent_name, :string, size: 100, null: false
      add :llm_model, :string, size: 100, null: false
      add :previous_affinity, :decimal, precision: 3, scale: 2
      add :new_affinity, :decimal, precision: 3, scale: 2
      add :reason, :text
      add :preferred_ratio, :decimal, precision: 3, scale: 2
      add :sample_size, :integer
      add :changed_by, :string, size: 50, default: "auto"
      timestamps(updated_at: false)
    end

    create index(:darwin_recommender_history, [:agent_name])
    create index(:darwin_recommender_history, [:inserted_at])
  end
end
