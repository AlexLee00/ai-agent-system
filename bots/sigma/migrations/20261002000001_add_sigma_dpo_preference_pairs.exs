defmodule TeamJay.Repo.Migrations.AddSigmaDpoPreferencePairs do
  use Ecto.Migration

  def change do
    create table(:sigma_dpo_preference_pairs) do
      add :cycle_id, :string, null: false
      add :date, :date
      add :analyst, :string
      add :team, :string
      add :metrics, :map
      add :score, :float
      add :critique, :text
      add :improvements, :map
      add :category, :string
      timestamps(inserted_at: :inserted_at, updated_at: false)
    end

    create unique_index(:sigma_dpo_preference_pairs, [:cycle_id])
    create index(:sigma_dpo_preference_pairs, [:analyst, :category])
    create index(:sigma_dpo_preference_pairs, [:inserted_at])
  end
end
