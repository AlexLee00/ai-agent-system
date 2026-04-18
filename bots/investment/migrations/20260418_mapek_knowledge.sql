-- LUNA_REMODEL Phase 2: MAPE-K Knowledge 저장소

CREATE TABLE IF NOT EXISTS investment.mapek_knowledge (
  id          BIGSERIAL   PRIMARY KEY,
  event_type  TEXT        NOT NULL,   -- 'signal_outcome','risk_violation','daily_briefing','mapek_cycle'
  payload     JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mapek_knowledge_event_created
  ON investment.mapek_knowledge (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mapek_knowledge_payload
  ON investment.mapek_knowledge USING GIN (payload);

-- 시장 레짐 스냅샷 (MarketRegimeDetector 소비)
CREATE TABLE IF NOT EXISTS investment.market_regime_snapshots (
  id          BIGSERIAL   PRIMARY KEY,
  market      TEXT        NOT NULL,   -- 'crypto','domestic','overseas'
  regime      TEXT        NOT NULL,   -- 'trending_bull','trending_bear','ranging','volatile'
  confidence  NUMERIC(5,3) DEFAULT 0.5,
  indicators  JSONB       DEFAULT '{}',
  captured_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_regime_market_captured
  ON investment.market_regime_snapshots (market, captured_at DESC);
