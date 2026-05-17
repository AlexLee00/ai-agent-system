defmodule TeamJay.Repo.Migrations.AddDarwinPipelineAuditCompat do
  use Ecto.Migration

  def change do
    create_if_not_exists table(:darwin_v2_pipeline_audit) do
      add :paper_id, :bigint
      add :paper_url, :text
      add :paper_title, :text
      add :pipeline_stage, :string
      add :stage, :string
      add :status, :string
      add :autonomy_level, :integer, default: 3
      add :model_used, :string
      add :cost_usd, :decimal, precision: 10, scale: 8, default: 0
      add :duration_ms, :integer
      add :score, :float
      add :result, :map, default: %{}
      add :metadata, :map, default: %{}
      add :error_reason, :text
      add :inserted_at, :utc_datetime_usec, null: false
    end

    execute """
    ALTER TABLE darwin_v2_pipeline_audit
      ADD COLUMN IF NOT EXISTS paper_id BIGINT,
      ADD COLUMN IF NOT EXISTS paper_url TEXT,
      ADD COLUMN IF NOT EXISTS paper_title TEXT,
      ADD COLUMN IF NOT EXISTS pipeline_stage VARCHAR(50),
      ADD COLUMN IF NOT EXISTS stage VARCHAR(50),
      ADD COLUMN IF NOT EXISTS status VARCHAR(20),
      ADD COLUMN IF NOT EXISTS autonomy_level INTEGER DEFAULT 3,
      ADD COLUMN IF NOT EXISTS model_used VARCHAR(100),
      ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 8) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
      ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS result JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS error_reason TEXT,
      ADD COLUMN IF NOT EXISTS inserted_at TIMESTAMPTZ DEFAULT NOW()
    """, ""

    execute "CREATE INDEX IF NOT EXISTS idx_darwin_audit_paper ON darwin_v2_pipeline_audit(paper_id, pipeline_stage)", ""
    execute "CREATE INDEX IF NOT EXISTS idx_darwin_audit_stage ON darwin_v2_pipeline_audit(stage, inserted_at)", ""
    execute "CREATE INDEX IF NOT EXISTS idx_darwin_audit_pipeline_stage ON darwin_v2_pipeline_audit(pipeline_stage, inserted_at)", ""
    execute "CREATE INDEX IF NOT EXISTS idx_darwin_audit_paper_url ON darwin_v2_pipeline_audit(paper_url)", ""
  end
end
