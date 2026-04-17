defmodule TeamJay.Repo.Migrations.AddDarwinV2CoreTables do
  use Ecto.Migration

  def change do
    # darwin_autonomy_level — L3/L4/L5 상태 영속
    create table(:darwin_autonomy_level) do
      add :level,                  :string,   null: false, default: "L3"
      add :reason,                 :string,   null: false, default: "initial"
      add :consecutive_successes,  :integer,  null: false, default: 0
      add :apply_count,            :integer,  null: false, default: 0
      add :error_count,            :integer,  null: false, default: 0
      add :last_error,             :text
      add :level_since,            :utc_datetime_usec
      timestamps()
    end

    create index(:darwin_autonomy_level, [:level])
    create index(:darwin_autonomy_level, [:inserted_at])

    # darwin_v2_shadow_runs — v1 vs v2 병행 비교 기록
    create table(:darwin_v2_shadow_runs) do
      add :run_date,           :date,       null: false
      add :cycle_result,       :map
      add :v1_run_id,          :bigint
      add :match_score,        :float
      add :notes,              :text
      timestamps()
    end

    create index(:darwin_v2_shadow_runs, [:run_date])
    create index(:darwin_v2_shadow_runs, [:run_date, :match_score])

    # darwin_v2_memories — L2 pgvector 장기 기억
    execute "CREATE EXTENSION IF NOT EXISTS vector"

    create table(:darwin_v2_memories) do
      add :team,         :string,  null: false, default: "darwin"
      add :content,      :text,    null: false
      add :memory_type,  :string,  null: false, default: "semantic"
      add :importance,   :float,   null: false, default: 0.5
      add :source,       :string
      add :expires_at,   :utc_datetime_usec
      timestamps()
    end

    execute "ALTER TABLE darwin_v2_memories ADD COLUMN embedding vector(1024)"
    create index(:darwin_v2_memories, [:team, :memory_type])
    create index(:darwin_v2_memories, [:importance])
    execute "CREATE INDEX darwin_v2_memories_embedding_idx ON darwin_v2_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)"

    # darwin_v2_analyst_prompts — ESPL 진화용 프롬프트 저장
    create table(:darwin_v2_analyst_prompts) do
      add :analyst,      :string,  null: false
      add :prompt_body,  :text,    null: false
      add :generation,   :integer, null: false, default: 0
      add :score,        :float,   null: false, default: 0.0
      add :active,       :boolean, null: false, default: false
      timestamps()
    end

    create index(:darwin_v2_analyst_prompts, [:analyst, :active])
    create index(:darwin_v2_analyst_prompts, [:analyst, :generation])
  end
end
