BEGIN;

CREATE TABLE IF NOT EXISTS investment.jaenong_reference_snapshot (
  id                  BIGSERIAL PRIMARY KEY,
  snapshot_hash       TEXT NOT NULL UNIQUE CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  revision            TEXT NOT NULL,
  source_file_name    TEXT NOT NULL,
  source_modified_at  TIMESTAMPTZ NOT NULL,
  parser_version      TEXT NOT NULL,
  timing              JSONB NOT NULL DEFAULT '{}'::jsonb,
  barometer           JSONB NOT NULL DEFAULT '[]'::jsonb,
  interest            JSONB NOT NULL DEFAULT '[]'::jsonb,
  c17_proposal        JSONB NOT NULL DEFAULT '{}'::jsonb,
  quote_fallbacks     JSONB NOT NULL DEFAULT '[]'::jsonb,
  parse_status        TEXT NOT NULL CHECK (parse_status IN ('parsed', 'partial', 'failed')),
  shadow_only         BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_only),
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jaenong_reference_snapshot_captured
  ON investment.jaenong_reference_snapshot (captured_at DESC, id DESC);

COMMENT ON TABLE investment.jaenong_reference_snapshot IS
  'Structured JAENONG reference workbook snapshots only; raw workbook content is never persisted.';

CREATE TABLE IF NOT EXISTS investment.jaenong_brief (
  id                       BIGSERIAL PRIMARY KEY,
  brief_ref                TEXT NOT NULL UNIQUE,
  source_kind              TEXT NOT NULL CHECK (source_kind IN ('post', 'manual', 'fixture')),
  source_post_id           TEXT,
  reference_snapshot_hash  TEXT,
  published_at             TIMESTAMPTZ NOT NULL,
  parsed_at                TIMESTAMPTZ NOT NULL,
  expires_at               TIMESTAMPTZ NOT NULL,
  market_adjustment        SMALLINT NOT NULL CHECK (market_adjustment BETWEEN -1 AND 1),
  market_view              TEXT NOT NULL DEFAULT '',
  candidate_symbols        JSONB NOT NULL DEFAULT '[]'::jsonb
                           CHECK (jsonb_typeof(candidate_symbols) = 'array'),
  state                    TEXT NOT NULL CHECK (state IN (
                             'awaiting_ack', 'active', 'stale', 'expired', 'invalid', 'parse_failed'
                           )),
  invalidated_at           TIMESTAMPTZ,
  invalid_reason           TEXT,
  shadow_only              BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_only),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jaenong_brief_published
  ON investment.jaenong_brief (published_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS investment.jaenong_brief_ack (
  id               BIGSERIAL PRIMARY KEY,
  brief_ref        TEXT NOT NULL REFERENCES investment.jaenong_brief(brief_ref) ON DELETE CASCADE,
  actor            TEXT NOT NULL,
  acknowledged_at  TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brief_ref, actor)
);

CREATE TABLE IF NOT EXISTS investment.jaenong_brief_event (
  id          BIGSERIAL PRIMARY KEY,
  brief_ref   TEXT,
  event_type  TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  reason      TEXT,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_only),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS investment.jaenong_route_shadow (
  id                       BIGSERIAL PRIMARY KEY,
  signal_ref               TEXT NOT NULL UNIQUE,
  created_at               TIMESTAMPTZ NOT NULL,
  selected_track           TEXT NOT NULL CHECK (selected_track IN ('pullback', 'top-volume')),
  priority                 SMALLINT NOT NULL CHECK (priority IN (1, 2)),
  selected_candidates      JSONB NOT NULL DEFAULT '[]'::jsonb,
  treatment                JSONB NOT NULL,
  control_group            JSONB NOT NULL,
  reference_snapshot_hash  TEXT,
  brief_ref                TEXT,
  c17_risk                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only              BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_only),
  execution_connected      BOOLEAN NOT NULL DEFAULT FALSE CHECK (NOT execution_connected),
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jaenong_route_shadow_recorded
  ON investment.jaenong_route_shadow (recorded_at DESC, id DESC);

COMMIT;
