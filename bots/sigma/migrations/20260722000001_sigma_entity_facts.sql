BEGIN;

CREATE TABLE IF NOT EXISTS sigma.entity_facts (
  id BIGSERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'general',
  fact TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.700,
  source_event_id BIGINT,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team, agent_name, entity, entity_type)
);

ALTER TABLE sigma.entity_facts
  ADD COLUMN IF NOT EXISTS entity_type TEXT,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS source_event_id BIGINT,
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

UPDATE sigma.entity_facts
SET entity_type = COALESCE(entity_type, 'general'),
    confidence = COALESCE(confidence, 0.700),
    created_at = COALESCE(created_at, NOW()),
    updated_at = COALESCE(updated_at, NOW())
WHERE entity_type IS NULL
   OR confidence IS NULL
   OR created_at IS NULL
   OR updated_at IS NULL;

ALTER TABLE sigma.entity_facts
  ALTER COLUMN entity_type SET DEFAULT 'general',
  ALTER COLUMN entity_type SET NOT NULL,
  ALTER COLUMN confidence SET DEFAULT 0.700,
  ALTER COLUMN confidence SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT NOW(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS entity_facts_team_agent_name_entity_entity_type_key
  ON sigma.entity_facts (team, agent_name, entity, entity_type);

CREATE INDEX IF NOT EXISTS idx_sigma_entity_facts_lookup
  ON sigma.entity_facts (team, agent_name, entity, confidence DESC);

CREATE INDEX IF NOT EXISTS idx_sigma_entity_facts_valid
  ON sigma.entity_facts (valid_until, updated_at DESC);

COMMIT;
