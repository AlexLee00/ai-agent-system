CREATE TABLE IF NOT EXISTS investment.hmm_regime_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol               TEXT NOT NULL,
  market               TEXT NOT NULL,
  current_regime       TEXT NOT NULL,
  regime_probabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  transition_matrix    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence           NUMERIC,
  features             JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only          BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hmm_regime_log_symbol_created
  ON investment.hmm_regime_log(symbol, market, created_at DESC);

CREATE TABLE IF NOT EXISTS investment.garch_volatility_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol              TEXT NOT NULL,
  market              TEXT NOT NULL,
  volatility_forecast JSONB NOT NULL DEFAULT '{}'::jsonb,
  var95               NUMERIC,
  var99               NUMERIC,
  position_size_factor NUMERIC,
  features            JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only         BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_garch_volatility_log_symbol_created
  ON investment.garch_volatility_log(symbol, market, created_at DESC);

CREATE TABLE IF NOT EXISTS investment.finbert_sentiment_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol         TEXT,
  market         TEXT,
  sentiment      TEXT NOT NULL,
  score          NUMERIC,
  confidence     NUMERIC,
  model          TEXT DEFAULT 'finbert_lexical_fallback',
  evidence_count INTEGER DEFAULT 0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only    BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finbert_sentiment_log_symbol_created
  ON investment.finbert_sentiment_log(symbol, market, created_at DESC);

CREATE TABLE IF NOT EXISTS investment.worldquant_alpha_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol      TEXT NOT NULL,
  market      TEXT NOT NULL,
  alpha_id    TEXT NOT NULL,
  alpha_value NUMERIC,
  composite   NUMERIC,
  rank        INTEGER,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worldquant_alpha_log_symbol_alpha_created
  ON investment.worldquant_alpha_log(symbol, market, alpha_id, created_at DESC);
