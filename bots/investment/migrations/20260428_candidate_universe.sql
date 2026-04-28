-- Phase A Discovery: 동적 universe 후보 테이블
-- candidate_screening.ex의 하드코딩 5개 → DB 기반 50~150개로 확장
-- Kill switch: LUNA_DISCOVERY_ORCHESTRATOR_ENABLED=false → 폴백 하드코딩 유지

CREATE TABLE IF NOT EXISTS investment.candidate_universe (
  id            BIGSERIAL     PRIMARY KEY,
  symbol        TEXT          NOT NULL,
  market        TEXT          NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  source        TEXT          NOT NULL,
  source_tier   INTEGER       NOT NULL DEFAULT 2 CHECK (source_tier IN (1, 2)),
  score         NUMERIC(5,4)  NOT NULL DEFAULT 0.5000,
  reason        TEXT,
  raw_data      JSONB         DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  UNIQUE (symbol, market, source)
);

-- 활성 후보 조회 (market + 점수 정렬)
CREATE INDEX IF NOT EXISTS idx_candidate_universe_market_score
  ON investment.candidate_universe (market, score DESC)
  WHERE expires_at > NOW();

-- TTL 만료 정리용
CREATE INDEX IF NOT EXISTS idx_candidate_universe_expires
  ON investment.candidate_universe (expires_at);

-- 소스별 최신 조회
CREATE INDEX IF NOT EXISTS idx_candidate_universe_source
  ON investment.candidate_universe (source, market, discovered_at DESC);
