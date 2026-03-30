CREATE TABLE IF NOT EXISTS ohlcv_cache (
  exchange    VARCHAR(32)   NOT NULL DEFAULT 'binance',
  symbol      VARCHAR(32)   NOT NULL,
  timeframe   VARCHAR(16)   NOT NULL,
  candle_ts   BIGINT        NOT NULL,
  open        DOUBLE PRECISION NOT NULL,
  high        DOUBLE PRECISION NOT NULL,
  low         DOUBLE PRECISION NOT NULL,
  close       DOUBLE PRECISION NOT NULL,
  volume      DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, symbol, timeframe, candle_ts)
);

CREATE INDEX IF NOT EXISTS idx_ohlcv_cache_symbol_tf_ts
  ON ohlcv_cache(symbol, timeframe, candle_ts DESC);
