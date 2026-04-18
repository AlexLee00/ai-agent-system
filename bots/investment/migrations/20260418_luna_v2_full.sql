-- CODEX_LUNA_REMODEL Phase 3~5 DB 마이그레이션
-- 2026-04-18

-- ─── Phase 3: Shadow 비교 테이블 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luna_v2_shadow_comparison (
  id         BIGSERIAL PRIMARY KEY,
  market     TEXT NOT NULL,
  orders_json JSONB,
  score      NUMERIC(4,3),
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_luna_shadow_market_ts ON luna_v2_shadow_comparison (market, created_at DESC);

-- ─── Phase 4: Strategy Registry ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luna_strategy_registry (
  id                  BIGSERIAL PRIMARY KEY,
  strategy_id         TEXT UNIQUE NOT NULL,
  version             TEXT NOT NULL DEFAULT '1.0.0',
  market              TEXT NOT NULL,
  description         TEXT,
  feature_profile     JSONB NOT NULL DEFAULT '{}',
  parameter_snapshot  JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'backtest',
  active_flag         BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  promoted_at         TIMESTAMPTZ,
  retired_at          TIMESTAMPTZ,
  metadata            JSONB
);
CREATE INDEX IF NOT EXISTS idx_luna_strategy_market_status ON luna_strategy_registry (market, status);
CREATE INDEX IF NOT EXISTS idx_luna_strategy_active ON luna_strategy_registry (active_flag) WHERE active_flag = true;

CREATE TABLE IF NOT EXISTS luna_strategy_validation_runs (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     TEXT NOT NULL,
  version         TEXT NOT NULL DEFAULT '1.0.0',
  validation_type TEXT NOT NULL,
  period_from     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_to       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metrics         JSONB NOT NULL DEFAULT '{}',
  result_summary  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_luna_validation_strategy ON luna_strategy_validation_runs (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS luna_strategy_promotion_log (
  id          BIGSERIAL PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  from_stage  TEXT,
  to_stage    TEXT NOT NULL,
  reason      TEXT,
  approver    TEXT DEFAULT 'auto',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Phase 4: Prediction Engine ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luna_prediction_feature_snapshot (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT NOT NULL,
  market     TEXT NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  features   JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_luna_prediction_symbol_ts ON luna_prediction_feature_snapshot (symbol, timestamp DESC);

-- ─── Phase 4: Agentic RAG (pgvector) ──────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS luna_rag_documents (
  id         BIGSERIAL PRIMARY KEY,
  doc_id     UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  category   TEXT NOT NULL,
  symbol     TEXT,
  market     TEXT,
  content    TEXT NOT NULL,
  embedding  vector(1024),
  metadata   JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW 인덱스 (수만 건 이상 최적)
CREATE INDEX IF NOT EXISTS idx_luna_rag_embedding_hnsw
  ON luna_rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_luna_rag_category ON luna_rag_documents (category);
CREATE INDEX IF NOT EXISTS idx_luna_rag_symbol_market ON luna_rag_documents (symbol, market);

-- ─── Phase 4: Self-Rewarding DPO ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS luna_dpo_preference_pairs (
  id              BIGSERIAL PRIMARY KEY,
  trade_id        BIGINT,
  rationale       TEXT NOT NULL,
  outcome_summary JSONB NOT NULL DEFAULT '{}',
  score           NUMERIC(3,2) NOT NULL DEFAULT 0.50,
  critique        TEXT,
  category        TEXT NOT NULL DEFAULT 'neutral',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_luna_dpo_category_score ON luna_dpo_preference_pairs (category, score DESC);

-- ─── Phase 3 LLM Routing Log (investment 레이어) ───────────────────────────

CREATE TABLE IF NOT EXISTS investment_llm_routing_log (
  id            BIGSERIAL PRIMARY KEY,
  agent         TEXT,
  caller_team   TEXT DEFAULT 'luna',
  provider      TEXT,
  abstract_model TEXT,
  duration_ms   INTEGER,
  cost_usd      NUMERIC(10,6),
  shadow_mode   BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_investment_llm_log_ts ON investment_llm_routing_log (created_at DESC);
