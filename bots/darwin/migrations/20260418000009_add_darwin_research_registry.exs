defmodule TeamJay.Repo.Migrations.AddDarwinResearchRegistry do
  use Ecto.Migration

  def change do
    create table(:darwin_research_registry) do
      add :paper_id, :string, size: 120, null: false
      add :title, :text, null: false
      add :authors, {:array, :text}, default: []
      add :source, :string, size: 50, null: false
      add :url, :text
      add :discovered_at, :utc_datetime
      add :stage, :string, size: 30, null: false
      add :keywords, {:array, :text}, default: []
      add :metadata, :map, default: %{}
      timestamps()
    end

    create unique_index(:darwin_research_registry, [:paper_id])
    create index(:darwin_research_registry, [:stage])
    create index(:darwin_research_registry, [:inserted_at])

    create table(:darwin_research_effects) do
      add :paper_id, :string, size: 120, null: false
      add :effect_type, :string, size: 50, null: false
      add :target, :text
      add :commit_sha, :string, size: 60
      add :before_metrics, :map
      add :after_metrics, :map
      add :improvement_pct, :decimal, precision: 7, scale: 2
      add :measured_at, :utc_datetime
      timestamps(updated_at: false)
    end

    create index(:darwin_research_effects, [:paper_id])
    create index(:darwin_research_effects, [:improvement_pct])

    create table(:darwin_research_promotion_log) do
      add :paper_id, :string, size: 120, null: false
      add :from_stage, :string, size: 30
      add :to_stage, :string, size: 30, null: false
      add :metadata, :map, default: %{}
      timestamps(updated_at: false)
    end

    create index(:darwin_research_promotion_log, [:paper_id])
    create index(:darwin_research_promotion_log, [:inserted_at])
  end
end
