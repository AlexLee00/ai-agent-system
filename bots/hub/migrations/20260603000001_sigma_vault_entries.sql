-- Week 3: 시그마 Vault DB 통합 테이블
-- Tiago Forte PARA 시스템 + pgvector 시맨틱 검색

CREATE SCHEMA IF NOT EXISTS sigma;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sigma.vault_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'note',
  content       TEXT,
  embedding     vector(1024),            -- Qwen3-Embedding-0.6B (1024차원)
  tags          TEXT[]       DEFAULT '{}',
  para_category TEXT NOT NULL DEFAULT 'inbox'
                  CHECK (para_category IN ('inbox', 'projects', 'areas', 'resources', 'archives')),
  file_path     TEXT,                    -- vault 파일 상대경로 (있으면)
  source        TEXT DEFAULT 'vault',   -- vault / sigma / luna / darwin / manual
  status        TEXT DEFAULT 'captured' CHECK (status IN ('captured', 'classified', 'archived')),
  meta          JSONB DEFAULT '{}',     -- 분류 reasoning, confidence, tags 등
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_para
  ON sigma.vault_entries (para_category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_created
  ON sigma.vault_entries (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_status
  ON sigma.vault_entries (status, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sigma_vault_entries_file_path
  ON sigma.vault_entries (file_path)
  WHERE file_path IS NOT NULL;

-- pgvector 코사인 유사도 검색 인덱스 (embedding 있을 때)
CREATE INDEX IF NOT EXISTS idx_sigma_vault_entries_embedding
  ON sigma.vault_entries USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

-- Vault 감사 로그 (이동/분류 이력)
CREATE TABLE IF NOT EXISTS sigma.vault_audit (
  id            BIGSERIAL PRIMARY KEY,
  entry_id      UUID REFERENCES sigma.vault_entries(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('created', 'classified', 'moved', 'archived', 'tagged')),
  from_category TEXT,
  to_category   TEXT,
  classifier    TEXT DEFAULT 'rule',    -- rule / llm / manual
  confidence    NUMERIC(4,3),           -- 0.000 ~ 1.000
  reasoning     TEXT,
  applied       BOOLEAN NOT NULL DEFAULT FALSE,
  dry_run       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_audit_entry
  ON sigma.vault_audit (entry_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sigma_vault_audit_created
  ON sigma.vault_audit (created_at DESC);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION sigma.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vault_entries_updated_at ON sigma.vault_entries;
CREATE TRIGGER trg_vault_entries_updated_at
  BEFORE UPDATE ON sigma.vault_entries
  FOR EACH ROW EXECUTE FUNCTION sigma.set_updated_at();
