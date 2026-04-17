defmodule TeamJay.Repo.Migrations.AddDarwinV2ExtendedTables do
  use Ecto.Migration

  def change do
    execute "CREATE EXTENSION IF NOT EXISTS vector", ""

    # L2 장기 메모리 (pgvector)
    create_if_not_exists table(:darwin_agent_memory) do
      add :team,        :string,  null: false, default: "darwin"
      add :content,     :text,    null: false
      add :memory_type, :string,  null: false, default: "semantic"
      add :importance,  :float,   null: false, default: 0.5
      add :context,     :map
      add :tags,        :map
      add :expires_at,  :utc_datetime_usec
      add :inserted_at, :utc_datetime_usec, null: false
    end

    execute """
      DO $$ BEGIN
        ALTER TABLE darwin_agent_memory ADD COLUMN IF NOT EXISTS embedding vector(1024);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$
    """, ""

    create_if_not_exists index(:darwin_agent_memory, [:team, :memory_type])
    create_if_not_exists index(:darwin_agent_memory, [:importance])
    execute """
      CREATE INDEX IF NOT EXISTS darwin_agent_memory_embedding_idx
      ON darwin_agent_memory USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 50)
    """, "DROP INDEX IF EXISTS darwin_agent_memory_embedding_idx"

    # ESPL 진화 프롬프트 저장
    create_if_not_exists table(:darwin_v2_espl_prompts) do
      add :agent_name,   :string,  null: false
      add :prompt_text,  :text,    null: false
      add :version,      :integer, null: false, default: 1
      add :score,        :float,   null: false, default: 0.0
      add :active,       :boolean, null: false, default: true
      add :inserted_at,  :utc_datetime_usec, null: false
      add :updated_at,   :utc_datetime_usec, null: false
    end

    create_if_not_exists index(:darwin_v2_espl_prompts, [:agent_name, :version])
    create_if_not_exists index(:darwin_v2_espl_prompts, [:agent_name, :active])

    # 사이클 결과 기록 (ESPL 학습용)
    create_if_not_exists table(:darwin_v2_cycle_results) do
      add :agent_name,      :string,  null: false
      add :cycle_type,      :string,  null: false
      add :result_summary,  :text
      add :success,         :boolean, null: false, default: true
      add :metadata,        :map
      add :inserted_at,     :utc_datetime_usec, null: false
    end

    create_if_not_exists index(:darwin_v2_cycle_results, [:agent_name, :inserted_at])
    create_if_not_exists index(:darwin_v2_cycle_results, [:cycle_type, :success])
  end
end
