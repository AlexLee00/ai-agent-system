CREATE TABLE IF NOT EXISTS investment.jaenong_posts (
  id BIGSERIAL PRIMARY KEY,
  source_post_id TEXT NOT NULL UNIQUE,
  creator TEXT NOT NULL DEFAULT 'jaenong',
  published_at TIMESTAMPTZ,
  source_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content_snapshot TEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  is_private BOOLEAN NOT NULL DEFAULT true,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_private = true)
);

CREATE INDEX IF NOT EXISTS idx_jaenong_posts_published
  ON investment.jaenong_posts (published_at DESC);

CREATE TABLE IF NOT EXISTS investment.jaenong_post_scores (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES investment.jaenong_posts(id) ON DELETE CASCADE,
  parser_version TEXT NOT NULL,
  brief JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'partial', 'unavailable')),
  unavailable_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  score_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  score_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, parser_version)
);

CREATE INDEX IF NOT EXISTS idx_jaenong_post_scores_status
  ON investment.jaenong_post_scores (status, scored_at DESC);
