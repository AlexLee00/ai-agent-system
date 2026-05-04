defmodule TeamJay.Repo.Migrations.SigmaIntelligentLibraryTables do
  use Ecto.Migration

  def up do
    execute("CREATE SCHEMA IF NOT EXISTS sigma")

    execute("""
    CREATE TABLE IF NOT EXISTS sigma.entity_relationships (
      id BIGSERIAL PRIMARY KEY,
      source_entity TEXT NOT NULL,
      target_entity TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      confidence NUMERIC(4,3) NOT NULL DEFAULT 0.650,
      evidence_event_ids BIGINT[] NOT NULL DEFAULT '{}',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_entity, target_entity, relationship_type)
    )
    """)

    execute("""
    CREATE INDEX IF NOT EXISTS idx_sigma_entity_rel_source
      ON sigma.entity_relationships (source_entity, confidence DESC)
    """)

    execute("""
    CREATE INDEX IF NOT EXISTS idx_sigma_entity_rel_target
      ON sigma.entity_relationships (target_entity, confidence DESC)
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS sigma.data_lineage (
      data_id TEXT PRIMARY KEY,
      source_event_id BIGINT,
      source_team TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_by JSONB NOT NULL DEFAULT '[]',
      consumed_by JSONB NOT NULL DEFAULT '[]',
      content_hash TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'
    )
    """)

    execute("""
    CREATE INDEX IF NOT EXISTS idx_sigma_data_lineage_source
      ON sigma.data_lineage (source_team, source_agent, ingested_at DESC)
    """)

    execute("""
    CREATE TABLE IF NOT EXISTS sigma.dataset_snapshots (
      id BIGSERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      dataset TEXT NOT NULL,
      week_label TEXT NOT NULL,
      schema JSONB NOT NULL DEFAULT '{}',
      stats JSONB NOT NULL DEFAULT '{}',
      lineage_hash TEXT NOT NULL,
      external_export_allowed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, dataset, week_label)
    )
    """)
  end

  def down do
    execute("DROP TABLE IF EXISTS sigma.dataset_snapshots")
    execute("DROP TABLE IF EXISTS sigma.data_lineage")
    execute("DROP TABLE IF EXISTS sigma.entity_relationships")
  end
end
