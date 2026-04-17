defmodule TeamJay.Repo.Migrations.AddDarwinPapersEmbeddings do
  use Ecto.Migration

  def up do
    execute "CREATE EXTENSION IF NOT EXISTS vector"

    create table(:darwin_papers_embeddings) do
      add :arxiv_id, :string, size: 50
      add :title, :text, null: false
      add :abstract, :text
      add :domain, :string, size: 100
      add :relevance_score, :decimal, precision: 3, scale: 1
      add :implementation_outcome, :string, size: 20, default: "pending"
      add :metadata, :map
      timestamps(updated_at: false)
    end

    execute "ALTER TABLE darwin_papers_embeddings ADD COLUMN embedding vector(1024)"
    execute "CREATE INDEX idx_darwin_papers_embedding ON darwin_papers_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)"
    create unique_index(:darwin_papers_embeddings, [:arxiv_id])
    create index(:darwin_papers_embeddings, [:domain])
  end

  def down do
    drop table(:darwin_papers_embeddings)
  end
end
