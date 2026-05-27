defmodule TeamJay.Repo.Migrations.LunaLearningBridgeTables do
  use Ecto.Migration

  def up do
    execute "CREATE SCHEMA IF NOT EXISTS sigma"
    execute "CREATE EXTENSION IF NOT EXISTS pgcrypto"

    execute """
    CREATE TABLE IF NOT EXISTS sigma.entity_facts (
      id BIGSERIAL PRIMARY KEY,
      team TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      fact TEXT NOT NULL,
      confidence NUMERIC(4,3) NOT NULL DEFAULT 0.700,
      source_event_id BIGINT,
      valid_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (team, agent_name, entity, entity_type)
    )
    """

    execute """
    ALTER TABLE sigma.entity_facts
      ADD COLUMN IF NOT EXISTS team TEXT,
      ADD COLUMN IF NOT EXISTS agent_name TEXT,
      ADD COLUMN IF NOT EXISTS entity TEXT,
      ADD COLUMN IF NOT EXISTS entity_type TEXT,
      ADD COLUMN IF NOT EXISTS fact TEXT,
      ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3),
      ADD COLUMN IF NOT EXISTS source_event_id BIGINT,
      ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ
    """

    execute """
    UPDATE sigma.entity_facts
       SET entity_type = COALESCE(entity_type, 'general'),
           confidence = COALESCE(confidence, 0.700),
           created_at = COALESCE(created_at, NOW()),
           updated_at = COALESCE(updated_at, NOW())
     WHERE entity_type IS NULL
        OR confidence IS NULL
        OR created_at IS NULL
        OR updated_at IS NULL
    """

    execute """
    ALTER TABLE sigma.entity_facts
      ALTER COLUMN entity_type SET DEFAULT 'general',
      ALTER COLUMN entity_type SET NOT NULL,
      ALTER COLUMN confidence SET DEFAULT 0.700,
      ALTER COLUMN confidence SET NOT NULL,
      ALTER COLUMN created_at SET DEFAULT NOW(),
      ALTER COLUMN created_at SET NOT NULL,
      ALTER COLUMN updated_at SET DEFAULT NOW(),
      ALTER COLUMN updated_at SET NOT NULL
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_sigma_entity_facts_lookup
      ON sigma.entity_facts (team, agent_name, entity, confidence DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_sigma_entity_facts_valid
      ON sigma.entity_facts (valid_until, updated_at DESC)
    """

    execute """
    CREATE TABLE IF NOT EXISTS sigma.feedback_effectiveness (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feedback_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      target_team VARCHAR(20) NOT NULL,
      feedback_type VARCHAR(30) NOT NULL,
      content TEXT,
      formation JSONB DEFAULT '{}'::jsonb,
      analyst_used VARCHAR(30),
      before_metric JSONB DEFAULT '{}'::jsonb,
      after_metric JSONB DEFAULT '{}'::jsonb,
      effectiveness DOUBLE PRECISION,
      effective BOOLEAN,
      measured_at TIMESTAMPTZ,
      measured BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
    """

    execute """
    ALTER TABLE sigma.feedback_effectiveness
      ADD COLUMN IF NOT EXISTS feedback_date TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS target_team VARCHAR(20),
      ADD COLUMN IF NOT EXISTS feedback_type VARCHAR(30),
      ADD COLUMN IF NOT EXISTS content TEXT,
      ADD COLUMN IF NOT EXISTS formation JSONB,
      ADD COLUMN IF NOT EXISTS analyst_used VARCHAR(30),
      ADD COLUMN IF NOT EXISTS before_metric JSONB,
      ADD COLUMN IF NOT EXISTS after_metric JSONB,
      ADD COLUMN IF NOT EXISTS effectiveness DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS effective BOOLEAN,
      ADD COLUMN IF NOT EXISTS measured_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS measured BOOLEAN,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ
    """

    execute """
    UPDATE sigma.feedback_effectiveness
       SET feedback_date = COALESCE(feedback_date, NOW()),
           formation = COALESCE(formation, '{}'::jsonb),
           before_metric = COALESCE(before_metric, '{}'::jsonb),
           after_metric = COALESCE(after_metric, '{}'::jsonb),
           measured = COALESCE(measured, FALSE),
           created_at = COALESCE(created_at, NOW())
     WHERE feedback_date IS NULL
        OR formation IS NULL
        OR before_metric IS NULL
        OR after_metric IS NULL
        OR measured IS NULL
        OR created_at IS NULL
    """

    execute """
    ALTER TABLE sigma.feedback_effectiveness
      ALTER COLUMN feedback_date SET DEFAULT NOW(),
      ALTER COLUMN formation SET DEFAULT '{}'::jsonb,
      ALTER COLUMN before_metric SET DEFAULT '{}'::jsonb,
      ALTER COLUMN after_metric SET DEFAULT '{}'::jsonb,
      ALTER COLUMN measured SET DEFAULT FALSE,
      ALTER COLUMN created_at SET DEFAULT NOW()
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_sigma_feedback_effectiveness_team
      ON sigma.feedback_effectiveness (target_team, feedback_date DESC)
    """

    execute """
    CREATE INDEX IF NOT EXISTS idx_sigma_feedback_effectiveness_analyst
      ON sigma.feedback_effectiveness (analyst_used, feedback_date DESC)
    """
  end

  def down do
    execute "DROP INDEX IF EXISTS sigma.idx_sigma_feedback_effectiveness_analyst"
    execute "DROP INDEX IF EXISTS sigma.idx_sigma_feedback_effectiveness_team"
    execute "DROP TABLE IF EXISTS sigma.feedback_effectiveness"
    execute "DROP INDEX IF EXISTS sigma.idx_sigma_entity_facts_valid"
    execute "DROP INDEX IF EXISTS sigma.idx_sigma_entity_facts_lookup"
    execute "DROP TABLE IF EXISTS sigma.entity_facts"
  end
end
