-- Phase 1 Luna 자동화: candidate_backtest_status + predictive_validation_log
-- Task 2: 후보별 백테스트 신선도/건강도 상태
CREATE TABLE IF NOT EXISTS candidate_backtest_status (
  id                    BIGSERIAL PRIMARY KEY,
  symbol                TEXT NOT NULL,
  market                TEXT NOT NULL,
  fresh                 BOOLEAN DEFAULT FALSE,
  healthy               BOOLEAN DEFAULT FALSE,
  sharpe                DOUBLE PRECISION,
  max_drawdown          DOUBLE PRECISION,
  win_rate              DOUBLE PRECISION,
  last_backtest_at      TIMESTAMPTZ,
  next_refresh_at       TIMESTAMPTZ,
  gate_status           TEXT DEFAULT 'pending',
  would_block           BOOLEAN DEFAULT FALSE,
  enforced              BOOLEAN DEFAULT FALSE,
  block_reasons         JSONB DEFAULT '[]'::jsonb,
  backtest_run_metadata JSONB DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (symbol, market)
);
ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS would_block BOOLEAN DEFAULT FALSE;
ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS enforced BOOLEAN DEFAULT FALSE;
ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS block_reasons JSONB DEFAULT '[]'::jsonb;
ALTER TABLE candidate_backtest_status ADD COLUMN IF NOT EXISTS backtest_run_metadata JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_cbs_gate   ON candidate_backtest_status(gate_status, fresh, healthy);
CREATE INDEX IF NOT EXISTS idx_cbs_symbol ON candidate_backtest_status(symbol, market);
CREATE INDEX IF NOT EXISTS idx_cbs_would_block ON candidate_backtest_status(would_block, updated_at DESC);

-- Task 3: 모든 예측 검증 fire/block 감사 로그
CREATE TABLE IF NOT EXISTS predictive_validation_log (
  id                  BIGSERIAL PRIMARY KEY,
  symbol              TEXT,
  market              TEXT,
  decision            TEXT NOT NULL,
  score               DOUBLE PRECISION,
  threshold           DOUBLE PRECISION,
  component_coverage  DOUBLE PRECISION,
  blocked_reason      TEXT,
  components          JSONB DEFAULT '{}'::jsonb,
  missing_components  JSONB DEFAULT '[]'::jsonb,
  candidate_snapshot  JSONB DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pvl_symbol   ON predictive_validation_log(symbol, market, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pvl_decision ON predictive_validation_log(decision, created_at DESC);
