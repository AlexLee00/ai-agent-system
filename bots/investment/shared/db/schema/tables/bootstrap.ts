// @ts-nocheck
/**
 * Bootstrap DDL family for the investment schema.
 *
 * This is a behavior-preserving extraction from shared/db/schema-init.ts so
 * schema-init can stay a small orchestrator while the historical DDL contract
 * remains byte-for-byte close to the previous execution order.
 */

export const INVESTMENT_SCHEMA_BOOTSTRAP_FAMILY = 'bootstrap';

export async function runInvestmentSchemaBootstrap(run, { log = true } = {}) {
  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS analysis (
      id         TEXT DEFAULT gen_random_uuid()::text,
      symbol     TEXT NOT NULL,
      analyst    TEXT NOT NULL,
      signal     TEXT NOT NULL,
      confidence DOUBLE PRECISION,
      reasoning  TEXT,
      metadata   JSONB,
      exchange   TEXT DEFAULT 'binance',
      created_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS signals (
      id          TEXT DEFAULT gen_random_uuid()::text,
      symbol      TEXT NOT NULL,
      action      TEXT NOT NULL,
      amount_usdt DOUBLE PRECISION,
      confidence  DOUBLE PRECISION,
      reasoning   TEXT,
      status      TEXT DEFAULT 'pending',
      exchange    TEXT DEFAULT 'binance',
      created_at  TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS trades (
      id          TEXT DEFAULT gen_random_uuid()::text,
      signal_id   TEXT,
      symbol      TEXT NOT NULL,
      side        TEXT NOT NULL,
      amount      DOUBLE PRECISION,
      price       DOUBLE PRECISION,
      total_usdt  DOUBLE PRECISION,
      paper       BOOLEAN DEFAULT true,
      exchange    TEXT DEFAULT 'binance',
      executed_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS positions (
      symbol         TEXT NOT NULL,
      amount         DOUBLE PRECISION DEFAULT 0,
      avg_price      DOUBLE PRECISION DEFAULT 0,
      unrealized_pnl DOUBLE PRECISION DEFAULT 0,
      paper          BOOLEAN DEFAULT false,
      execution_mode TEXT DEFAULT 'live',
      broker_account_mode TEXT,
      exchange       TEXT DEFAULT 'binance',
      trade_mode     TEXT DEFAULT 'normal',
      UNIQUE(symbol, exchange, paper, trade_mode),
      updated_at     TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS strategy_pool (
      id                   TEXT DEFAULT gen_random_uuid()::text,
      strategy_name        TEXT UNIQUE NOT NULL,
      market               TEXT NOT NULL,
      source               TEXT,
      source_url           TEXT,
      entry_condition      TEXT,
      exit_condition       TEXT,
      risk_management      TEXT,
      applicable_timeframe TEXT,
      quality_score        DOUBLE PRECISION DEFAULT 0.0,
      summary              TEXT,
      applicable_now       BOOLEAN DEFAULT true,
      collected_at         TIMESTAMP DEFAULT now(),
      applied_count        INTEGER DEFAULT 0,
      win_rate             DOUBLE PRECISION
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS position_strategy_profiles (
      id                   TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      symbol               TEXT NOT NULL,
      exchange             TEXT NOT NULL,
      signal_id            TEXT,
      trade_mode           TEXT DEFAULT 'normal',
      status               TEXT DEFAULT 'active',
      strategy_name        TEXT,
      strategy_quality_score DOUBLE PRECISION,
      setup_type           TEXT,
      thesis               TEXT,
      monitoring_plan      JSONB DEFAULT '{}'::jsonb,
      exit_plan            JSONB DEFAULT '{}'::jsonb,
      backtest_plan        JSONB DEFAULT '{}'::jsonb,
      market_context       JSONB DEFAULT '{}'::jsonb,
      strategy_context     JSONB DEFAULT '{}'::jsonb,
      created_at           TIMESTAMPTZ DEFAULT now(),
      updated_at           TIMESTAMPTZ DEFAULT now(),
      closed_at            TIMESTAMPTZ
    )
  `);
  try {
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_position_strategy_profiles_active_scope
      ON position_strategy_profiles(symbol, exchange, trade_mode)
      WHERE status = 'active'
    `);
  } catch { /* 무시 */ }
  try {
    await run(`
      CREATE INDEX IF NOT EXISTS idx_position_strategy_profiles_signal_id
      ON position_strategy_profiles(signal_id, created_at DESC)
    `);
  } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS risk_log (
      id           TEXT DEFAULT gen_random_uuid()::text,
      trace_id     TEXT UNIQUE NOT NULL,
      symbol       TEXT,
      exchange     TEXT,
      decision     TEXT,
      risk_score   INTEGER,
      reason       TEXT,
      evaluated_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS asset_snapshot (
      id         TEXT DEFAULT gen_random_uuid()::text,
      equity     DOUBLE PRECISION NOT NULL,
      value_usd  DOUBLE PRECISION,
      snapped_at TIMESTAMP DEFAULT now()
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS market_regime_snapshots (
      id          TEXT DEFAULT gen_random_uuid()::text,
      market      TEXT NOT NULL,
      regime      TEXT NOT NULL,
      confidence  DOUBLE PRECISION DEFAULT 0.5,
      indicators  JSONB DEFAULT '{}'::jsonb,
      captured_at TIMESTAMP DEFAULT now()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_market_regime_market_captured ON market_regime_snapshots(market, captured_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS mapek_knowledge (
      id          BIGSERIAL PRIMARY KEY,
      event_type  TEXT NOT NULL,
      payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ DEFAULT now()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_mapek_knowledge_event_created ON mapek_knowledge(event_type, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_mapek_knowledge_payload ON mapek_knowledge USING GIN (payload)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS runtime_config_suggestion_log (
      id                TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      period_days       INTEGER NOT NULL,
      actionable_count  INTEGER DEFAULT 0,
      market_summary    JSONB NOT NULL,
      suggestions       JSONB NOT NULL,
      review_status     TEXT DEFAULT 'pending',
      review_note       TEXT,
      reviewed_at       TIMESTAMP,
      applied_at        TIMESTAMP,
      captured_at       TIMESTAMP DEFAULT now()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS llm_backtest_quality (
      id              TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      model           TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      layer           INTEGER NOT NULL,
      accuracy        DOUBLE PRECISION,
      match_rate      DOUBLE PRECISION,
      sample_count    INTEGER DEFAULT 0,
      summary         JSONB,
      created_at      TIMESTAMP DEFAULT now()
    )
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_llm_backtest_quality_model_symbol
    ON llm_backtest_quality(model, symbol, created_at DESC)
  `);
  await run(`
    CREATE INDEX IF NOT EXISTS idx_runtime_config_suggestion_log_captured_at
    ON runtime_config_suggestion_log(captured_at DESC)
  `);
  for (const [col, type] of [
    ['reviewed_at', 'TIMESTAMP'],
    ['applied_at', 'TIMESTAMP'],
    ['policy_snapshot', 'JSONB'],
  ]) {
    try { await run(`ALTER TABLE runtime_config_suggestion_log ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  // signals 컬럼 추가 (없으면 추가)
  for (const [col, type] of [
    ['trace_id',        'TEXT'],
    ['block_reason',    'TEXT'],
    ['block_code',      'TEXT'],
    ['block_meta',      'JSONB'],
    ['analyst_signals', 'TEXT'],  // 분석 봇 4인 신호 패턴 (예: "A:B|O:B|H:N|S:B")
    ['trade_mode',      `TEXT DEFAULT 'normal'`],
    ['nemesis_verdict', 'TEXT'],        // SEC-004: approved | modified | rejected | null(미경유)
    ['approved_at',     'TIMESTAMPTZ'], // SEC-004: stale signal 감지용
    ['partial_exit_ratio', 'DOUBLE PRECISION'],
    ['strategy_family', 'TEXT'],
    ['strategy_quality', 'TEXT'],
    ['strategy_readiness', 'DOUBLE PRECISION'],
    ['strategy_route', 'JSONB'],
    ['execution_origin', `TEXT DEFAULT 'strategy'`],
    ['quality_flag', `TEXT DEFAULT 'trusted'`],
    ['exclude_from_learning', 'BOOLEAN DEFAULT false'],
    ['incident_link', 'TEXT'],
  ]) {
    try { await run(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  // trades TP/SL 컬럼
  for (const [col, type] of [
    ['tp_price', 'DOUBLE PRECISION'], ['sl_price', 'DOUBLE PRECISION'],
    ['tp_order_id', 'TEXT'], ['sl_order_id', 'TEXT'],
    ['tp_sl_set', 'BOOLEAN DEFAULT false'],
    ['partial_exit', 'BOOLEAN DEFAULT false'],
    ['partial_exit_ratio', 'DOUBLE PRECISION'],
    ['remaining_amount', 'DOUBLE PRECISION'],
    ['trade_mode', `TEXT DEFAULT 'normal'`],
    ['execution_origin', `TEXT DEFAULT 'strategy'`],
    ['quality_flag', `TEXT DEFAULT 'trusted'`],
    ['exclude_from_learning', 'BOOLEAN DEFAULT false'],
    ['incident_link', 'TEXT'],
  ]) {
    try { await run(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* 무시 */ }
  }

  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS paper BOOLEAN DEFAULT false`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'live'`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS broker_account_mode TEXT`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS trade_mode TEXT DEFAULT 'normal'`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE position_strategy_profiles ADD COLUMN IF NOT EXISTS strategy_state JSONB DEFAULT '{}'::jsonb`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE position_strategy_profiles ADD COLUMN IF NOT EXISTS last_evaluation_at TIMESTAMPTZ`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE position_strategy_profiles ADD COLUMN IF NOT EXISTS last_attention_at TIMESTAMPTZ`); } catch { /* 무시 */ }
  await run(`
    CREATE TABLE IF NOT EXISTS agent_role_profiles (
      agent_id           TEXT PRIMARY KEY,
      team               TEXT NOT NULL,
      primary_role       TEXT NOT NULL,
      secondary_roles    JSONB DEFAULT '[]'::jsonb,
      capabilities       JSONB DEFAULT '[]'::jsonb,
      default_priority   INTEGER DEFAULT 50,
      metadata           JSONB DEFAULT '{}'::jsonb,
      updated_at         TIMESTAMPTZ DEFAULT now()
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS agent_role_state (
      id                 TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      agent_id           TEXT NOT NULL,
      team               TEXT NOT NULL,
      scope_type         TEXT NOT NULL,
      scope_key          TEXT NOT NULL,
      mission            TEXT NOT NULL,
      role_mode          TEXT NOT NULL,
      priority           INTEGER DEFAULT 50,
      status             TEXT DEFAULT 'active',
      reason             TEXT,
      state              JSONB DEFAULT '{}'::jsonb,
      created_at         TIMESTAMPTZ DEFAULT now(),
      updated_at         TIMESTAMPTZ DEFAULT now()
    )
  `);
  try {
    await run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_role_state_active_scope
      ON agent_role_state(agent_id, scope_type, scope_key)
      WHERE status = 'active'
    `);
  } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_role_state_scope_updated ON agent_role_state(scope_type, scope_key, updated_at DESC)`); } catch { /* 무시 */ }
  try { await run(`UPDATE positions SET execution_mode = CASE WHEN paper = true THEN 'paper' ELSE 'live' END WHERE execution_mode IS NULL OR execution_mode = ''`); } catch { /* 무시 */ }
  try { await run(`UPDATE positions SET trade_mode = 'normal' WHERE trade_mode IS NULL`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey`); } catch { /* 무시 */ }
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_scope_unique ON positions(symbol, exchange, paper, trade_mode)`); } catch { /* 무시 */ }

  // ── screening_history (아르고스 동적 종목 스크리닝 이력) ──
  await run(`
    CREATE TABLE IF NOT EXISTS screening_history (
      id              TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      date            DATE NOT NULL,
      market          TEXT NOT NULL,
      core_symbols    JSONB,
      dynamic_symbols JSONB,
      screening_data  JSONB,
      created_at      TIMESTAMP DEFAULT now()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_screening_date ON screening_history(date, market)`);

  // ── dual_model_results (멀티 모델 경쟁 결과 상세 기록) ──
  await run(`
    CREATE TABLE IF NOT EXISTS dual_model_results (
      id                  TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      agent               TEXT NOT NULL,
      symbol              TEXT,
      cycle_id            TEXT,
      oss_response        TEXT,
      oss_signal          TEXT,
      oss_confidence      DOUBLE PRECISION,
      oss_reasoning       TEXT,
      oss_score           DOUBLE PRECISION,
      oss_parseable       BOOLEAN DEFAULT false,
      oss_latency_ms      INTEGER,
      oss_input_tokens    INTEGER DEFAULT 0,
      oss_output_tokens   INTEGER DEFAULT 0,
      scout_response      TEXT,
      scout_signal        TEXT,
      scout_confidence    DOUBLE PRECISION,
      scout_reasoning     TEXT,
      scout_score         DOUBLE PRECISION,
      scout_parseable     BOOLEAN DEFAULT false,
      scout_latency_ms    INTEGER,
      scout_input_tokens  INTEGER DEFAULT 0,
      scout_output_tokens INTEGER DEFAULT 0,
      winner              TEXT NOT NULL,
      win_reason          TEXT,
      score_diff          DOUBLE PRECISION,
      signals_agree       BOOLEAN DEFAULT false,
      created_at          TIMESTAMP DEFAULT now()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_agent    ON dual_model_results(agent, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_winner   ON dual_model_results(winner, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_dual_symbol   ON dual_model_results(symbol, created_at)`);

  // ── position_lifecycle_events (Phase 6 라이프사이클 감사 로그) ──
  await run(`
    CREATE TABLE IF NOT EXISTS position_lifecycle_events (
      id                  TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      position_scope_key  TEXT NOT NULL,
      exchange            TEXT NOT NULL,
      symbol              TEXT NOT NULL,
      trade_mode          TEXT DEFAULT 'normal',
      phase               TEXT NOT NULL,
      stage_id            TEXT,
      owner_agent         TEXT,
      event_type          TEXT NOT NULL,
      input_snapshot      JSONB DEFAULT '{}'::jsonb,
      output_snapshot     JSONB DEFAULT '{}'::jsonb,
      policy_snapshot     JSONB DEFAULT '{}'::jsonb,
      evidence_snapshot   JSONB DEFAULT '{}'::jsonb,
      idempotency_key     TEXT,
      created_at          TIMESTAMPTZ DEFAULT now()
    )
  `);
  try { await run(`ALTER TABLE position_lifecycle_events ADD COLUMN IF NOT EXISTS stage_id TEXT`); } catch { /* 무시 */ }
  try {
    await run(`
      ALTER TABLE position_lifecycle_events
      ADD CONSTRAINT chk_ple_stage_id
      CHECK (
        stage_id IS NULL
        OR stage_id IN (
          'stage_1','stage_2','stage_3','stage_4',
          'stage_5','stage_6','stage_7','stage_8'
        )
      )
    `);
  } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_ple_scope_phase ON position_lifecycle_events(position_scope_key, phase, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_ple_symbol_phase ON position_lifecycle_events(symbol, exchange, phase, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_ple_stage_symbol ON position_lifecycle_events(stage_id, symbol, exchange, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ple_idempotency ON position_lifecycle_events(idempotency_key) WHERE idempotency_key IS NOT NULL`); } catch { /* 무시 */ }

  // ── position_closeout_reviews (Phase 6 청산 회고 기록) ──
  await run(`
    CREATE TABLE IF NOT EXISTS position_closeout_reviews (
      id                        TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      signal_id                 TEXT,
      trade_id                  TEXT,
      journal_id                TEXT,
      exchange                  TEXT NOT NULL,
      symbol                    TEXT NOT NULL,
      trade_mode                TEXT DEFAULT 'normal',
      closeout_type             TEXT NOT NULL,
      closeout_reason           TEXT,
      planned_ratio             DOUBLE PRECISION,
      executed_ratio            DOUBLE PRECISION,
      planned_notional          DOUBLE PRECISION,
      executed_notional         DOUBLE PRECISION,
      slippage_pct              DOUBLE PRECISION,
      fee_total                 DOUBLE PRECISION,
      pnl_realized              DOUBLE PRECISION,
      pnl_remaining_unrealized  DOUBLE PRECISION,
      regime                    TEXT,
      setup_type                TEXT,
      strategy_family           TEXT,
      family_bias               TEXT,
      autonomy_phase            TEXT,
      review_status             TEXT DEFAULT 'pending',
      review_result             JSONB DEFAULT '{}'::jsonb,
      policy_suggestions        JSONB DEFAULT '[]'::jsonb,
      idempotency_key           TEXT,
      created_at                TIMESTAMPTZ DEFAULT now(),
      reviewed_at               TIMESTAMPTZ
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_pcr_symbol ON position_closeout_reviews(symbol, exchange, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_pcr_review_status ON position_closeout_reviews(review_status, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_idempotency ON position_closeout_reviews(idempotency_key) WHERE idempotency_key IS NOT NULL`); } catch { /* 무시 */ }
  try { await run(`ALTER TABLE position_closeout_reviews ADD COLUMN IF NOT EXISTS autonomy_phase TEXT`); } catch { /* 무시 */ }

  // ── candidate_universe (Phase A Discovery: 동적 universe 후보) ──
  await run(`
    CREATE TABLE IF NOT EXISTS candidate_universe (
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
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_market_score ON candidate_universe (market, score DESC) WHERE expires_at > NOW()`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_expires ON candidate_universe (expires_at)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_candidate_universe_source ON candidate_universe (source, market, discovered_at DESC)`); } catch { /* 무시 */ }

  // ── external_evidence_events (외부 에비던스 레저) ──
  await run(`
    CREATE TABLE IF NOT EXISTS external_evidence_events (
      id                TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      source_type       TEXT NOT NULL,
      source_name       TEXT,
      source_url        TEXT,
      symbol            TEXT,
      market            TEXT,
      strategy_family   TEXT,
      signal_direction  TEXT,
      score             DOUBLE PRECISION DEFAULT 0,
      source_quality    DOUBLE PRECISION DEFAULT 0.5,
      freshness_score   DOUBLE PRECISION DEFAULT 1.0,
      evidence_summary  TEXT,
      raw_ref           JSONB DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ DEFAULT now()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_eee_source_type ON external_evidence_events(source_type, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_eee_symbol ON external_evidence_events(symbol, market, created_at DESC)`); } catch { /* 무시 */ }

  // ── position_signal_history (Phase D Continuous Signal Collection) ──
  await run(`
    CREATE TABLE IF NOT EXISTS position_signal_history (
      id               TEXT DEFAULT gen_random_uuid()::text PRIMARY KEY,
      position_scope_key TEXT NOT NULL,
      exchange         TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      trade_mode       TEXT DEFAULT 'normal',
      source           TEXT NOT NULL,
      event_type       TEXT NOT NULL DEFAULT 'signal_refresh',
      confidence       DOUBLE PRECISION DEFAULT 0.0,
      sentiment_score  DOUBLE PRECISION DEFAULT 0.0,
      evidence_snapshot JSONB DEFAULT '{}'::jsonb,
      quality_flags    JSONB DEFAULT '[]'::jsonb,
      created_at       TIMESTAMPTZ DEFAULT now()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_psh_scope_created ON position_signal_history(position_scope_key, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_psh_symbol_created ON position_signal_history(symbol, exchange, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_psh_source_created ON position_signal_history(source, created_at DESC)`); } catch { /* 무시 */ }

  // ── Agent Memory + LLM Routing core tables (A~H) ──
  await run(`
    CREATE TABLE IF NOT EXISTS agent_short_term_memory (
      id           BIGSERIAL PRIMARY KEY,
      agent_name   TEXT NOT NULL,
      incident_key TEXT,
      symbol       TEXT,
      market       TEXT,
      content      JSONB NOT NULL DEFAULT '{}'::jsonb,
      expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_stm_active ON agent_short_term_memory(agent_name, symbol, expires_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_stm_incident ON agent_short_term_memory(incident_key, agent_name, created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS luna_rag_documents (
      id          BIGSERIAL PRIMARY KEY,
      owner_agent TEXT,
      category    TEXT NOT NULL,
      market      TEXT,
      symbol      TEXT,
      content     TEXT NOT NULL,
      metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_luna_rag_docs_lookup ON luna_rag_documents(owner_agent, category, market, symbol, created_at DESC)`); } catch { /* 무시 */ }

  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS owner_agent TEXT`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS category TEXT`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS market TEXT`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS symbol TEXT`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS content TEXT`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
  await run(`ALTER TABLE luna_rag_documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`).catch(() => {});

  await run(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'investment'
          AND table_name = 'luna_rag_documents'
          AND column_name = 'owner_agent'
      ) THEN
        ALTER TABLE luna_rag_documents ADD COLUMN owner_agent TEXT;
      END IF;
    END $$;
  `).catch(() => {});
  try { await run(`CREATE INDEX IF NOT EXISTS idx_luna_rag_owner_agent ON luna_rag_documents(owner_agent, category, created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS entity_facts (
      id                     BIGSERIAL PRIMARY KEY,
      entity                 TEXT NOT NULL,
      entity_type            TEXT NOT NULL,
      fact                   TEXT NOT NULL,
      confidence             NUMERIC(3,2) NOT NULL DEFAULT 0.70,
      source                 TEXT,
      derived_from_trade_ids BIGINT[] DEFAULT '{}',
      valid_from             TIMESTAMPTZ DEFAULT NOW(),
      valid_until            TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_entity_facts_lookup ON entity_facts(entity, entity_type, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_entity_facts_confidence ON entity_facts(confidence DESC, created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS agent_curriculum_state (
      id               BIGSERIAL PRIMARY KEY,
      agent_name       TEXT NOT NULL,
      market           TEXT NOT NULL DEFAULT 'any',
      invocation_count INTEGER NOT NULL DEFAULT 0,
      success_count    INTEGER NOT NULL DEFAULT 0,
      failure_count    INTEGER NOT NULL DEFAULT 0,
      current_level    TEXT NOT NULL DEFAULT 'novice',
      config           JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_promoted_at TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_name, market)
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_curriculum_agent_market ON agent_curriculum_state(agent_name, market)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id           BIGSERIAL PRIMARY KEY,
      incident_key TEXT,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'query',
      payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
      responded_at TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_messages_incident ON agent_messages(incident_key, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent ON agent_messages(to_agent, responded_at, created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS agent_context_log (
      id                  BIGSERIAL PRIMARY KEY,
      agent_name          TEXT NOT NULL,
      market              TEXT,
      task_type           TEXT,
      incident_key        TEXT,
      call_id             TEXT,
      persona_loaded      BOOLEAN DEFAULT false,
      constitution_loaded BOOLEAN DEFAULT false,
      rag_docs_count      INTEGER DEFAULT 0,
      failures_found      INTEGER DEFAULT 0,
      skills_found        INTEGER DEFAULT 0,
      short_term_found    INTEGER DEFAULT 0,
      entity_facts_found  INTEGER DEFAULT 0,
      working_state_used  BOOLEAN DEFAULT false,
      total_prefix_chars  INTEGER DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS market TEXT`).catch(() => {});
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS task_type TEXT`).catch(() => {});
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS incident_key TEXT`).catch(() => {});
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS short_term_found INTEGER DEFAULT 0`).catch(() => {});
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS entity_facts_found INTEGER DEFAULT 0`).catch(() => {});
  await run(`ALTER TABLE agent_context_log ADD COLUMN IF NOT EXISTS working_state_used BOOLEAN DEFAULT false`).catch(() => {});
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_context_log_agent ON agent_context_log(agent_name, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_context_log_task ON agent_context_log(market, task_type, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_context_log_incident ON agent_context_log(incident_key, created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS llm_failure_reflexions (
      id             BIGSERIAL PRIMARY KEY,
      agent_name     TEXT NOT NULL,
      market         TEXT,
      task_type      TEXT,
      provider       TEXT,
      error_type     TEXT,
      prompt_hash    TEXT,
      failure_count  INTEGER NOT NULL DEFAULT 1,
      last_failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      avoid_provider TEXT,
      reformulation  TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_failure_agent_hash ON llm_failure_reflexions(agent_name, prompt_hash, provider)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_llm_failure_recent ON llm_failure_reflexions(agent_name, last_failed_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS llm_routing_log (
      id             BIGSERIAL PRIMARY KEY,
      agent_name     TEXT NOT NULL,
      provider       TEXT,
      hub_text       TEXT,
      direct_text    TEXT,
      matched        BOOLEAN,
      response_ok    BOOLEAN,
      cost_usd       NUMERIC(12,8) DEFAULT 0,
      latency_ms     INTEGER DEFAULT 0,
      market         TEXT,
      symbol         TEXT,
      task_type      TEXT,
      incident_key   TEXT,
      shadow_mode    BOOLEAN DEFAULT false,
      fallback_used  BOOLEAN DEFAULT false,
      fallback_count INTEGER DEFAULT 0,
      error          TEXT,
      route_chain    JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS provider TEXT`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS response_ok BOOLEAN`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS task_type TEXT`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS incident_key TEXT`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN DEFAULT false`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS fallback_count INTEGER DEFAULT 0`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS error TEXT`).catch(() => {});
  await run(`ALTER TABLE llm_routing_log ADD COLUMN IF NOT EXISTS route_chain JSONB NOT NULL DEFAULT '[]'::jsonb`).catch(() => {});
  try { await run(`CREATE INDEX IF NOT EXISTS idx_llm_routing_log_agent_created ON llm_routing_log(agent_name, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_llm_routing_log_provider_created ON llm_routing_log(provider, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_llm_routing_log_response_ok ON llm_routing_log(response_ok, created_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_llm_routing_log_task ON llm_routing_log(market, task_type, created_at DESC)`); } catch { /* 무시 */ }

  // ── Posttrade feedback loop (A~H) ──
  await run(`
    CREATE TABLE IF NOT EXISTS trade_quality_evaluations (
      trade_id                   BIGINT PRIMARY KEY,
      market_decision_score      NUMERIC(4,3),
      pipeline_quality_score     NUMERIC(4,3),
      monitoring_score           NUMERIC(4,3),
      backtest_utilization_score NUMERIC(4,3),
      overall_score              NUMERIC(4,3),
      category                   TEXT,
      rationale                  TEXT,
      sub_score_breakdown        JSONB DEFAULT '{}',
      evaluated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_tqe_category_score ON trade_quality_evaluations (category, overall_score DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_tqe_evaluated_at ON trade_quality_evaluations (evaluated_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS trade_decision_attribution (
      trade_id                BIGINT NOT NULL,
      stage_id                TEXT   NOT NULL,
      decision_type           TEXT,
      decision_score          NUMERIC(4,3),
      contribution_to_outcome NUMERIC(5,4),
      evidence                JSONB DEFAULT '{}',
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (trade_id, stage_id)
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_tda_trade_id ON trade_decision_attribution (trade_id)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_tda_stage_contribution ON trade_decision_attribution (stage_id, contribution_to_outcome DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS luna_failure_reflexions (
      id                BIGSERIAL PRIMARY KEY,
      trade_id          BIGINT NOT NULL,
      five_why          JSONB DEFAULT '[]',
      stage_attribution JSONB DEFAULT '{}',
      hindsight         TEXT,
      avoid_pattern     JSONB DEFAULT '{}',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lfr_trade_unique ON luna_failure_reflexions (trade_id)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_lfr_trade_id ON luna_failure_reflexions (trade_id)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_lfr_avoid_pattern ON luna_failure_reflexions USING GIN (avoid_pattern)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_lfr_created_at ON luna_failure_reflexions (created_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS feedback_to_action_map (
      id                 BIGSERIAL PRIMARY KEY,
      source_trade_id    BIGINT,
      parameter_name     TEXT NOT NULL,
      old_value          JSONB DEFAULT 'null'::jsonb,
      new_value          JSONB DEFAULT 'null'::jsonb,
      reason             TEXT,
      suggestion_log_id  TEXT,
      metadata           JSONB DEFAULT '{}'::jsonb,
      applied_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_fam_source_trade ON feedback_to_action_map (source_trade_id, applied_at DESC)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_fam_parameter ON feedback_to_action_map (parameter_name, applied_at DESC)`); } catch { /* 무시 */ }

  await run(`
    CREATE TABLE IF NOT EXISTS luna_posttrade_skills (
      id                BIGSERIAL PRIMARY KEY,
      market            TEXT NOT NULL,
      agent_name        TEXT NOT NULL DEFAULT 'all',
      skill_type        TEXT NOT NULL,
      pattern_key       TEXT NOT NULL,
      title             TEXT NOT NULL,
      summary           TEXT NOT NULL,
      invocation_count  INTEGER DEFAULT 0,
      success_rate      DOUBLE PRECISION DEFAULT 0.0,
      win_count         INTEGER DEFAULT 0,
      loss_count        INTEGER DEFAULT 0,
      source_trade_ids  JSONB DEFAULT '[]'::jsonb,
      metadata          JSONB DEFAULT '{}'::jsonb,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (market, agent_name, skill_type, pattern_key)
    )
  `);
  await run(`ALTER TABLE luna_posttrade_skills DROP CONSTRAINT IF EXISTS luna_posttrade_skills_market_skill_type_pattern_key_key`).catch(() => {});
  await run(`ALTER TABLE luna_posttrade_skills ADD COLUMN IF NOT EXISTS agent_name TEXT NOT NULL DEFAULT 'all'`).catch(() => {});
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lps_unique_market_agent_pattern ON luna_posttrade_skills (market, agent_name, skill_type, pattern_key)`); } catch { /* 무시 */ }
  try { await run(`CREATE INDEX IF NOT EXISTS idx_lps_market_agent_type ON luna_posttrade_skills (market, agent_name, skill_type, success_rate DESC, updated_at DESC)`); } catch { /* 무시 */ }

  // 스키마 버전 기록
  try {
    for (const [v, name] of [
      [1, 'initial_schema'],
      [2, 'strategy_pool_risk_log_asset_snapshot'],
      [3, 'trades_tp_sl_columns'],
      [4, 'screening_history_dual_model_results'],
      [5, 'runtime_config_suggestion_log'],
      [6, 'positions_trade_mode_scope'],
      [7, 'positions_mode_metadata'],
      [8, 'agent_role_profiles_state'],
      [9, 'position_lifecycle_events'],
      [10, 'position_closeout_reviews'],
      [11, 'external_evidence_events'],
      [12, 'candidate_universe_phase_a_discovery'],
      [13, 'posttrade_feedback_loop_core'],
    ]) {
      await run(
        `INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [v, name],
      );
    }
  } catch { /* 무시 */ }

  if (log) console.error(`✅ DB 스키마 초기화 완료 (investment 스키마)`);

}

export default {
  INVESTMENT_SCHEMA_BOOTSTRAP_FAMILY,
  runInvestmentSchemaBootstrap,
};
