// @ts-nocheck
/**
 * shared/db.js — PostgreSQL investment 스키마 (Phase 4 마이그레이션)
 *
 * 위치: PostgreSQL jay DB, investment 스키마
 * 테이블: analysis, signals, trades, positions,
 *         strategy_pool, risk_log, asset_snapshot,
 *         runtime_config_suggestion_log, schema_migrations
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { createSchemaDbHelpers } = require('../../../packages/core/lib/db/helpers');
import { getInvestmentTradeMode, getExecutionMode, getBrokerAccountMode } from './secrets.ts';
import { getSignalDedupeWindowMinutes } from './runtime-config.ts';
import { resolveLunaAutonomyPhase } from './autonomy-phase.ts';

const SCHEMA = 'investment';
let _schemaInitPromise = null;
const schemaDb = createSchemaDbHelpers(pgPool, SCHEMA);

// ─── 기본 쿼리 래퍼 (외부 호환 API 유지) ──────────────────────────────

/** SELECT 쿼리 — rows 배열 반환 */
export function query(sql, params = []) {
  return schemaDb.query(sql, params);
}

/** INSERT / UPDATE / DELETE — { rowCount, rows } 반환 */
export function run(sql, params = []) {
  return schemaDb.run(sql, params);
}

/** 단일 행 SELECT — row 또는 null */
export function get(sql, params = []) {
  return schemaDb.get(sql, params);
}

/**
 * 스키마 트랜잭션 래퍼
 * - callback 내에서는 동일 DB 세션/트랜잭션을 공유한다.
 */
export async function withTransaction(fn) {
  if (typeof fn !== 'function') throw new Error('withTransaction requires callback function');
  return pgPool.transaction(SCHEMA, async (client) => {
    const tx = {
      query: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows || [];
      },
      run: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return { rowCount: result.rowCount, rows: result.rows || [] };
      },
      get: async (sql, params = []) => {
        const result = await client.query(sql, params);
        return result.rows?.[0] || null;
      },
    };
    return fn(tx, client);
  });
}

// ─── 스키마 초기화 ──────────────────────────────────────────────────

export async function initSchema() {
  if (_schemaInitPromise) return _schemaInitPromise;

  _schemaInitPromise = (async () => {
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
      call_id             TEXT,
      persona_loaded      BOOLEAN DEFAULT false,
      constitution_loaded BOOLEAN DEFAULT false,
      rag_docs_count      INTEGER DEFAULT 0,
      failures_found      INTEGER DEFAULT 0,
      skills_found        INTEGER DEFAULT 0,
      total_prefix_chars  INTEGER DEFAULT 0,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await run(`CREATE INDEX IF NOT EXISTS idx_agent_context_log_agent ON agent_context_log(agent_name, created_at DESC)`); } catch { /* 무시 */ }

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

  console.log(`✅ DB 스키마 초기화 완료 (investment 스키마)`);
  })();

  try {
    await _schemaInitPromise;
    return _schemaInitPromise;
  } catch (e) {
    _schemaInitPromise = null;
    throw e;
  }
}

// ─── analysis ───────────────────────────────────────────────────────

export async function insertAnalysis({ symbol, analyst, signal, confidence, reasoning, metadata, exchange = 'binance' }) {
  await run(
    `INSERT INTO analysis (symbol, analyst, signal, confidence, reasoning, metadata, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [symbol, analyst, signal, confidence ?? null, reasoning ?? null,
     metadata ? JSON.stringify(metadata) : null, exchange],
  );
}

export async function getRecentAnalysis(symbol, minutesBack = 30, exchange = null) {
  if (exchange) {
    return query(
      `SELECT * FROM analysis
       WHERE symbol = $1 AND exchange = $2
         AND created_at > now() - INTERVAL '1 minute' * $3
       ORDER BY created_at DESC`,
      [symbol, exchange, minutesBack],
    );
  }
  return query(
    `SELECT * FROM analysis
     WHERE symbol = $1 AND created_at > now() - INTERVAL '1 minute' * $2
     ORDER BY created_at DESC`,
    [symbol, minutesBack],
  );
}

// ─── signals ────────────────────────────────────────────────────────

export async function insertSignal({
  symbol,
  action,
  amountUsdt,
  confidence,
  reasoning,
  status = 'pending',
  exchange = 'binance',
  analystSignals = null,
  tradeMode = null,
  nemesisVerdict = null,
  approvedAt = null,
  partialExitRatio = null,
  strategyFamily = null,
  strategyQuality = null,
  strategyReadiness = null,
  strategyRoute = null,
  executionOrigin = 'strategy',
  qualityFlag = 'trusted',
  excludeFromLearning = false,
  incidentLink = null,
}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const rows = await query(
    `INSERT INTO signals (symbol, action, amount_usdt, confidence, reasoning, status, exchange, analyst_signals, trade_mode, nemesis_verdict, approved_at, partial_exit_ratio, strategy_family, strategy_quality, strategy_readiness, strategy_route, execution_origin, quality_flag, exclude_from_learning, incident_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id`,
    [
      symbol,
      action,
      amountUsdt ?? null,
      confidence ?? null,
      reasoning ?? null,
      status || 'pending',
      exchange,
      analystSignals ?? null,
      effectiveTradeMode,
      nemesisVerdict ?? null,
      approvedAt ?? null,
      partialExitRatio ?? null,
      strategyFamily ?? null,
      strategyQuality ?? null,
      strategyReadiness ?? null,
      strategyRoute ? JSON.stringify(strategyRoute) : null,
      executionOrigin || 'strategy',
      qualityFlag || 'trusted',
      excludeFromLearning === true,
      incidentLink ?? null,
    ],
  );
  return rows[0]?.id;
}

/**
 * @param {{
 *   symbol?: string,
 *   action?: string,
 *   exchange?: string,
 *   tradeMode?: string|null,
 *   minutesBack?: number
 * }} [input={}]
 * @returns {Promise<any>}
 */
export async function getRecentSignalDuplicate({
  symbol,
  action,
  exchange = 'binance',
  tradeMode = null,
  minutesBack = 180,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  return get(
    `SELECT *
       FROM signals
      WHERE symbol = $1
        AND action = $2
        AND exchange = $3
        AND COALESCE(trade_mode, 'normal') = $4
        AND created_at > now() - INTERVAL '1 minute' * $5
      ORDER BY created_at DESC
      LIMIT 1`,
    [symbol, action, exchange, effectiveTradeMode, minutesBack],
  );
}

/**
 * @param {{
 *   symbol?: string,
 *   action?: string|null,
 *   exchange?: string,
 *   tradeMode?: string|null,
 *   blockCode?: string,
 *   minutesBack?: number
 * }} [input={}]
 * @returns {Promise<any>}
 */
export async function getRecentBlockedSignalByCode({
  symbol,
  action = null,
  exchange = 'binance',
  tradeMode = null,
  blockCode,
  minutesBack = 1440,
} = {}) {
  if (!symbol || !blockCode) return null;
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const conditions = [
    `symbol = $1`,
    `exchange = $2`,
    `COALESCE(trade_mode, 'normal') = $3`,
    `COALESCE(block_code, '') = $4`,
    `created_at > now() - INTERVAL '1 minute' * $5`,
  ];
  const params = [symbol, exchange, effectiveTradeMode, blockCode, minutesBack];

  if (action) {
    params.push(action);
    conditions.push(`action = $${params.length}`);
  }

  return get(
    `SELECT *
       FROM signals
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  );
}

/**
 * @param {{
 *   symbol?: string,
 *   action?: string,
 *   amountUsdt?: number|null,
 *   confidence?: number|null,
 *   reasoning?: string|null,
 *   status?: string|null,
 *   exchange?: string,
 *   analystSignals?: object|null,
 *   tradeMode?: string|null,
 *   dedupeWindowMinutes?: number|null
 * }} [input={}]
 * @returns {Promise<{ id: any, duplicate: boolean, existingSignal: any, dedupeWindowMinutes: number }>}
 */
export async function insertSignalIfFresh({
  symbol,
  action,
  amountUsdt,
  confidence,
  reasoning,
  status = 'pending',
  exchange = 'binance',
  analystSignals = null,
  tradeMode = null,
  dedupeWindowMinutes = null,
  nemesisVerdict = null,
  approvedAt = null,
  strategyFamily = null,
  strategyQuality = null,
  strategyReadiness = null,
  strategyRoute = null,
  executionOrigin = 'strategy',
  qualityFlag = 'trusted',
  excludeFromLearning = false,
  incidentLink = null,
} = {}) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  const effectiveWindow = Number.isFinite(Number(dedupeWindowMinutes)) && Number(dedupeWindowMinutes) > 0
    ? Math.round(Number(dedupeWindowMinutes))
    : getSignalDedupeWindowMinutes();
  const duplicate = await getRecentSignalDuplicate({
    symbol,
    action,
    exchange,
    tradeMode: effectiveTradeMode,
    minutesBack: effectiveWindow,
  });

  if (duplicate) {
    return {
      id: duplicate.id,
      duplicate: true,
      existingSignal: duplicate,
      dedupeWindowMinutes: effectiveWindow,
    };
  }

  const id = await insertSignal({
    symbol,
    action,
    amountUsdt,
    confidence,
    reasoning,
    status: status || 'pending',
    exchange,
    analystSignals,
    tradeMode: effectiveTradeMode,
    nemesisVerdict,
    approvedAt,
    strategyFamily,
    strategyQuality,
    strategyReadiness,
    strategyRoute,
    executionOrigin,
    qualityFlag,
    excludeFromLearning,
    incidentLink,
  });

  return {
    id,
    duplicate: false,
    existingSignal: null,
    dedupeWindowMinutes: effectiveWindow,
  };
}

export async function updateSignalStatus(id, status) {
  await run(`UPDATE signals SET status = $1 WHERE id = $2`, [status, id]);
}

export async function updateSignalApproval(id, {
  status = 'approved',
  nemesisVerdict = null,
  approvedAt = null,
} = {}) {
  if (!id) return;
  await run(
    `UPDATE signals
        SET status = $1,
            nemesis_verdict = COALESCE($2, nemesis_verdict),
            approved_at = COALESCE($3, approved_at, now())
      WHERE id = $4`,
    [status, nemesisVerdict, approvedAt, id],
  );
}

export async function updateSignalAmount(id, amountUsdt) {
  await run(`UPDATE signals SET amount_usdt = $1 WHERE id = $2`, [amountUsdt, id]);
}

export async function updateSignalBlock(id, {
  status = null,
  reason = null,
  code = null,
  meta = null,
} = {}) {
  if (!id) return;

  const sets = [];
  const params = [];

  if (status) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  if (reason !== null) {
    params.push(reason);
    sets.push(`block_reason = $${params.length}`);
  }
  if (code !== null) {
    params.push(code);
    sets.push(`block_code = $${params.length}`);
  }
  if (meta !== null) {
    params.push(meta ? JSON.stringify(meta) : null);
    sets.push(`block_meta = $${params.length}`);
  }
  if (sets.length === 0) return;

  params.push(id);
  await run(`UPDATE signals SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export async function mergeSignalBlockMeta(id, meta = {}) {
  if (!id || !meta || typeof meta !== 'object') return;
  await run(
    `UPDATE signals
        SET block_meta = COALESCE(block_meta, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    [JSON.stringify(meta), id],
  );
}

export async function getSignalById(id) {
  return get(`SELECT * FROM signals WHERE id = $1`, [id]);
}

export async function getPendingSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'pending'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}

export async function getApprovedSignals(exchange, tradeMode = null) {
  const conditions = [`status = 'approved'`];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return query(
    `SELECT * FROM signals WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params,
  );
}

// ─── trades ─────────────────────────────────────────────────────────

export async function insertTrade({ signalId, symbol, side, amount, price, totalUsdt, paper, exchange = 'binance', tpPrice = null, slPrice = null, tpOrderId = null, slOrderId = null, tpSlSet = false, tradeMode = null, executionOrigin = 'strategy', qualityFlag = 'trusted', excludeFromLearning = false, incidentLink = null }) {
  const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
  await run(
    `INSERT INTO trades (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, tp_price, sl_price, tp_order_id, sl_order_id, tp_sl_set, trade_mode, execution_origin, quality_flag, exclude_from_learning, incident_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [signalId ?? null, symbol, side, amount, price, totalUsdt ?? null, paper !== false, exchange,
     tpPrice, slPrice, tpOrderId, slOrderId, tpSlSet ?? false, effectiveTradeMode,
     executionOrigin || 'strategy', qualityFlag || 'trusted', excludeFromLearning === true, incidentLink ?? null],
  );
}

export async function getTradeHistory(symbol, limit = 50) {
  if (symbol) {
    return query(`SELECT * FROM trades WHERE symbol = $1 ORDER BY executed_at DESC LIMIT $2`, [symbol, limit]);
  }
  return query(`SELECT * FROM trades ORDER BY executed_at DESC LIMIT $1`, [limit]);
}

export async function getLatestTradeBySignalId(signalId) {
  return get(`SELECT * FROM trades WHERE signal_id = $1 ORDER BY executed_at DESC LIMIT 1`, [signalId]);
}

/**
 * @param {{
 *   symbol?: string,
 *   side?: string,
 *   exchange?: string|null,
 *   tradeMode?: string|null
 * }} [input={}]
 * @returns {Promise<any>}
 */
export async function getSameDayTrade({
  symbol,
  side,
  exchange = null,
  tradeMode = null,
} = {}) {
  const conditions = [`symbol = $1`, `side = $2`, `executed_at::date = CURRENT_DATE`];
  const params = [symbol, side];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (tradeMode) {
    params.push(tradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  return get(
    `SELECT * FROM trades WHERE ${conditions.join(' AND ')} ORDER BY executed_at DESC LIMIT 1`,
    params,
  );
}

// ─── positions ──────────────────────────────────────────────────────

function isUnifiedLiveSymbolScope(exchange = null, paper = null) {
  return String(exchange || '').trim().toLowerCase() === 'binance' && paper !== true;
}

function canonicalizePositionTradeMode(exchange = null, paper = null, tradeMode = null) {
  if (isUnifiedLiveSymbolScope(exchange, paper)) return 'normal';
  return tradeMode || getInvestmentTradeMode();
}

export async function upsertPosition({ symbol, amount, avgPrice, unrealizedPnl, exchange = 'binance', paper = false, tradeMode = null }) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  const normalizedExchange = String(exchange || 'binance').trim().toLowerCase();
  const marketType = normalizedExchange === 'kis' || normalizedExchange === 'kis_overseas' ? 'stocks' : 'crypto';
  const executionMode = paper === true ? 'paper' : getExecutionMode();
  const brokerAccountMode = getBrokerAccountMode(marketType);
  await run(
    `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, execution_mode, broker_account_mode, exchange, trade_mode, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (symbol, exchange, paper, trade_mode) DO UPDATE SET
       amount         = EXCLUDED.amount,
       avg_price      = EXCLUDED.avg_price,
       unrealized_pnl = EXCLUDED.unrealized_pnl,
       paper          = EXCLUDED.paper,
       execution_mode = EXCLUDED.execution_mode,
       broker_account_mode = EXCLUDED.broker_account_mode,
       exchange       = EXCLUDED.exchange,
       trade_mode     = EXCLUDED.trade_mode,
       updated_at     = EXCLUDED.updated_at`,
    [symbol, amount, avgPrice, unrealizedPnl ?? 0, paper === true, executionMode, brokerAccountMode, exchange, effectiveTradeMode],
  );
}

export async function deletePositionsForExchangeScope(exchange, { paper = false, symbol = null } = {}) {
  const conditions = [`exchange = $1`, `paper = $2`];
  const params = [exchange, paper === true];

  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }

  return run(`DELETE FROM positions WHERE ${conditions.join(' AND ')}`, params);
}

export async function getPosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (effectiveTradeMode && !isUnifiedLiveSymbolScope(exchange, paper)) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  const orderBy = paper === null
    ? `ORDER BY paper ASC, updated_at DESC`
    : `ORDER BY updated_at DESC`;

  return get(`SELECT * FROM positions WHERE ${conditions.join(' AND ')} ${orderBy} LIMIT 1`, params);
}

export async function getLivePosition(symbol, exchange = null, tradeMode = null) {
  return getPosition(symbol, { exchange, paper: false, tradeMode });
}

export async function getPaperPosition(symbol, exchange = null, tradeMode = null) {
  return getPosition(symbol, { exchange, paper: true, tradeMode });
}

export async function getAllPositions(exchange = null, paper = null, tradeMode = null) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (exchange && paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = true AND COALESCE(trade_mode, 'normal') = $2 ORDER BY symbol`,
      [exchange, effectiveTradeMode],
    );
  }
  if (paper === true && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY symbol`,
      [effectiveTradeMode],
    );
  }
  if (exchange && paper === false && tradeMode && isUnifiedLiveSymbolScope(exchange, paper)) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = false ORDER BY symbol`,
      [exchange],
    );
  }
  if (exchange && paper !== null) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND exchange = $1 AND paper = $2 ORDER BY symbol`,
      [exchange, paper === true],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND exchange = $1 ORDER BY symbol`, [exchange]);
  }
  if (paper !== null) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = $1 ORDER BY symbol`, [paper === true]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 ORDER BY symbol`);
}

export async function getPaperPositions(exchange = null, tradeMode = null) {
  if (exchange && tradeMode) {
    return query(
      `SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 AND COALESCE(trade_mode, 'normal') = $2 ORDER BY updated_at ASC`,
      [exchange, tradeMode],
    );
  }
  if (exchange) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND exchange = $1 ORDER BY updated_at ASC`, [exchange]);
  }
  if (tradeMode) {
    return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true AND COALESCE(trade_mode, 'normal') = $1 ORDER BY updated_at ASC`, [tradeMode]);
  }
  return query(`SELECT * FROM positions WHERE amount > 0 AND paper = true ORDER BY updated_at ASC`);
}

export async function getOpenPositions(exchange = null, paper = false, tradeMode = null) {
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
  if (exchange && tradeMode && !isUnifiedLiveSymbolScope(exchange, paper)) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2 AND COALESCE(p.trade_mode, 'normal') = $3
       ORDER BY entry_time ASC`,
      [exchange, paper === true, effectiveTradeMode],
    );
  }
  if (exchange) {
    return query(
      `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
              COALESCE(p.trade_mode, 'normal') AS trade_mode,
              COALESCE(
                (
                  SELECT MIN(tj.entry_time)
                  FROM trade_journal tj
                  WHERE tj.symbol = p.symbol
                    AND tj.exchange = p.exchange
                    AND tj.is_paper = p.paper
                    AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                    AND tj.status = 'open'
                ),
                (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
              ) AS entry_time,
              p.updated_at
       FROM positions p
       WHERE p.amount > 0 AND p.exchange = $1 AND p.paper = $2
       ORDER BY entry_time ASC`,
      [exchange, paper === true],
    );
  }
  return query(
    `SELECT p.symbol, p.amount, p.avg_price, p.unrealized_pnl, p.exchange, p.paper,
            COALESCE(p.trade_mode, 'normal') AS trade_mode,
            COALESCE(
              (
                SELECT MIN(tj.entry_time)
                FROM trade_journal tj
                WHERE tj.symbol = p.symbol
                  AND tj.exchange = p.exchange
                  AND tj.is_paper = p.paper
                  AND COALESCE(tj.trade_mode, 'normal') = COALESCE(p.trade_mode, 'normal')
                  AND tj.status = 'open'
              ),
              (EXTRACT(EPOCH FROM p.updated_at) * 1000)::bigint
            ) AS entry_time,
            p.updated_at
     FROM positions p
     WHERE p.amount > 0 AND p.paper = $1
     ORDER BY entry_time ASC`,
    [paper === true],
  );
}

export async function deletePosition(symbol, { exchange = null, paper = null, tradeMode = null } = {}) {
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (paper !== null) {
    params.push(paper === true);
    conditions.push(`paper = $${params.length}`);
  }
  if ((tradeMode || paper !== null) && !isUnifiedLiveSymbolScope(exchange, paper)) {
    const effectiveMode = canonicalizePositionTradeMode(exchange, paper, tradeMode);
    params.push(effectiveMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }

  await run(`DELETE FROM positions WHERE ${conditions.join(' AND ')}`, params);
  await closePositionStrategyProfile(symbol, { exchange, tradeMode }).catch(() => {});
}

// ─── 집계 ───────────────────────────────────────────────────────────

export async function getTodayPnl(exchange = null) {
  const conditions = [
    `status = 'closed'`,
    `exit_time IS NOT NULL`,
    `to_timestamp(exit_time / 1000.0)::date = current_date`,
  ];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }

  const rows = await query(`
    SELECT
      COALESCE(SUM(pnl_net), 0) AS pnl,
      COUNT(*) AS trade_count
    FROM trade_journal
    WHERE ${conditions.join(' AND ')}
  `, params);
  return rows[0] || { pnl: 0, trade_count: 0 };
}

export async function insertScreeningHistory({ market, core = [], dynamic = [], screeningData = null }) {
  await run(`
    INSERT INTO screening_history (date, market, core_symbols, dynamic_symbols, screening_data)
    VALUES (CURRENT_DATE, $1, $2, $3, $4)
  `, [
    market,
    JSON.stringify(core),
    JSON.stringify(dynamic),
    screeningData ? JSON.stringify(screeningData) : null,
  ]);
}

export async function getRecentScreeningSymbols(market, limit = 3) {
  const rows = await query(`
    SELECT market, dynamic_symbols, core_symbols, screening_data, created_at
    FROM screening_history
    WHERE market = $1 OR market = 'all'
    ORDER BY created_at DESC
    LIMIT $2
  `, [market, limit]);

  const symbols = [];
  const isValidCryptoSymbol = (sym) => (
    typeof sym === 'string'
    && /^[A-Z0-9]+\/USDT$/.test(sym.trim().toUpperCase())
    && sym.trim().length > 6
  );
  for (const row of rows) {
    const screeningData = row.screening_data && typeof row.screening_data === 'object'
      ? row.screening_data
      : row.screening_data ? JSON.parse(row.screening_data) : null;

    const dynamic = row.market === 'all'
      ? (screeningData?.[market]?.dynamic || [])
      : Array.isArray(row.dynamic_symbols)
        ? row.dynamic_symbols
        : JSON.parse(row.dynamic_symbols || '[]');
    const core = row.market === 'all'
      ? (screeningData?.[market]?.core || [])
      : Array.isArray(row.core_symbols)
        ? row.core_symbols
        : row.core_symbols && typeof row.core_symbols === 'object'
          ? Object.values(row.core_symbols).flat()
          : JSON.parse(row.core_symbols || '[]');
    for (const sym of [...dynamic, ...core]) {
      if (market === 'crypto' && !isValidCryptoSymbol(sym)) continue;
      if (sym && !symbols.includes(sym)) symbols.push(sym);
    }
  }

  return symbols;
}

export async function getRecentScreeningDynamicSymbols(market, limit = 5) {
  const rows = await query(`
    SELECT market, dynamic_symbols, created_at
    FROM screening_history
    WHERE market = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [market, limit]);

  return rows.map((row) => ({
    market: row.market,
    created_at: row.created_at,
    dynamic_symbols: Array.isArray(row.dynamic_symbols)
      ? row.dynamic_symbols
      : JSON.parse(row.dynamic_symbols || '[]'),
  }));
}

export async function getRecentScreeningMarkets(limit = 6) {
  const rows = await query(`
    SELECT market, dynamic_symbols, created_at
    FROM screening_history
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  return rows.map((row) => ({
    market: String(row.market || '').trim() || 'unknown',
    created_at: row.created_at,
    dynamic_symbols: Array.isArray(row.dynamic_symbols)
      ? row.dynamic_symbols
      : JSON.parse(row.dynamic_symbols || '[]'),
  }));
}

// ─── strategy_pool ───────────────────────────────────────────────────

export async function upsertStrategy(s) {
  await run(`
    INSERT INTO strategy_pool
      (strategy_name, market, source, source_url,
       entry_condition, exit_condition, risk_management,
       applicable_timeframe, quality_score, summary, applicable_now, collected_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
    ON CONFLICT (strategy_name) DO UPDATE SET
      quality_score        = EXCLUDED.quality_score,
      summary              = EXCLUDED.summary,
      applicable_now       = EXCLUDED.applicable_now,
      collected_at         = EXCLUDED.collected_at
  `, [
    s.strategy_name, s.market, s.source ?? null, s.source_url ?? null,
    s.entry_condition ?? null, s.exit_condition ?? null, s.risk_management ?? null,
    s.applicable_timeframe ?? null, s.quality_score ?? 0, s.summary ?? null,
    s.applicable_now !== false,
  ]);
}

export async function getActiveStrategies(market = 'all', limit = 5) {
  const normalizedMarket = ['all', 'crypto', 'stocks'].includes(String(market)) ? String(market) : 'all';
  const normalizedLimit = Math.max(1, Math.min(50, Number.parseInt(String(limit), 10) || 5));

  return query(
    `
      SELECT * FROM strategy_pool
      WHERE applicable_now = true
        AND quality_score >= 0.6
        AND collected_at > now() - INTERVAL '7 days'
        AND ($1 = 'all' OR market = $1 OR market = 'all')
      ORDER BY quality_score DESC
      LIMIT $2
    `,
    [normalizedMarket, normalizedLimit],
  );
}

export async function recordStrategyResult(strategyName, won) {
  await run(`
    UPDATE strategy_pool
    SET applied_count = applied_count + 1,
        win_rate = (COALESCE(win_rate, 0.5) * applied_count + $1) / (applied_count + 1)
    WHERE strategy_name = $2
  `, [won ? 1 : 0, strategyName]);
}

export async function getLatestVectorbtBacktestForSymbol(symbol, days = 120) {
  if (!symbol) return null;
  return get(
    `SELECT symbol, days, tp_pct, sl_pct, label, status, sharpe, total_return, max_drawdown, win_rate, total_trades, metadata, created_at
     FROM vectorbt_backtest_runs
     WHERE symbol = $1
       AND created_at > now() - ($2::int || ' days')::interval
     ORDER BY created_at DESC
     LIMIT 1`,
    [symbol, days],
  );
}

export async function getLatestMarketRegimeSnapshot(market) {
  if (!market) return null;
  return get(
    `SELECT id, market, regime, confidence, indicators, captured_at
     FROM market_regime_snapshots
     WHERE market = $1
     ORDER BY captured_at DESC
     LIMIT 1`,
    [market],
  );
}

export async function getPositionStrategyProfile(symbol, {
  exchange = null,
  tradeMode = null,
  status = 'active',
} = {}) {
  if (!symbol) return null;
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  if (effectiveTradeMode) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  return get(
    `SELECT *
     FROM position_strategy_profiles
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    params,
  );
}

export async function getActivePositionStrategyProfiles({
  exchange = null,
  symbol = null,
  status = 'active',
  limit = 500,
} = {}) {
  const conditions = [];
  const params = [];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 500)));

  return query(
    `SELECT *
     FROM position_strategy_profiles
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function upsertPositionStrategyProfile({
  symbol,
  exchange,
  signalId = null,
  tradeMode = null,
  strategyName = null,
  strategyQualityScore = null,
  setupType = null,
  thesis = null,
  monitoringPlan = {},
  exitPlan = {},
  backtestPlan = {},
  marketContext = {},
  strategyContext = {},
} = {}) {
  if (!symbol || !exchange) return null;
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  const updated = await get(
    `UPDATE position_strategy_profiles
     SET signal_id = $1,
         strategy_name = $2,
         strategy_quality_score = $3,
         setup_type = $4,
         thesis = $5,
         monitoring_plan = $6,
         exit_plan = $7,
         backtest_plan = $8,
         market_context = $9,
         strategy_context = $10,
         updated_at = now()
     WHERE symbol = $11
       AND exchange = $12
       AND COALESCE(trade_mode, 'normal') = $13
       AND status = 'active'
     RETURNING *`,
    [
      signalId,
      strategyName,
      strategyQualityScore,
      setupType,
      thesis,
      JSON.stringify(monitoringPlan || {}),
      JSON.stringify(exitPlan || {}),
      JSON.stringify(backtestPlan || {}),
      JSON.stringify(marketContext || {}),
      JSON.stringify(strategyContext || {}),
      symbol,
      exchange,
      effectiveTradeMode,
    ],
  );
  if (updated) return updated;

  return get(
    `INSERT INTO position_strategy_profiles (
       symbol, exchange, signal_id, trade_mode, status,
       strategy_name, strategy_quality_score, setup_type, thesis,
       monitoring_plan, exit_plan, backtest_plan, market_context, strategy_context
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      symbol,
      exchange,
      signalId,
      effectiveTradeMode,
      strategyName,
      strategyQualityScore,
      setupType,
      thesis,
      JSON.stringify(monitoringPlan || {}),
      JSON.stringify(exitPlan || {}),
      JSON.stringify(backtestPlan || {}),
      JSON.stringify(marketContext || {}),
      JSON.stringify(strategyContext || {}),
    ],
  );
}

export async function updatePositionStrategyProfileState(symbol, {
  exchange = null,
  tradeMode = null,
  strategyState = {},
  lastEvaluationAt = null,
  lastAttentionAt = null,
} = {}) {
  if (!symbol || !exchange) return null;
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  return get(
    `UPDATE position_strategy_profiles
     SET strategy_state = COALESCE(strategy_state, '{}'::jsonb) || $1::jsonb,
         last_evaluation_at = COALESCE($2::timestamptz, now()),
         last_attention_at = CASE WHEN $3::timestamptz IS NULL THEN last_attention_at ELSE $3::timestamptz END,
         updated_at = now()
     WHERE symbol = $4
       AND exchange = $5
       AND COALESCE(trade_mode, 'normal') = $6
       AND status = 'active'
     RETURNING *`,
    [
      JSON.stringify(strategyState || {}),
      lastEvaluationAt,
      lastAttentionAt,
      symbol,
      exchange,
      effectiveTradeMode,
    ],
  );
}

export async function closePositionStrategyProfile(symbol, {
  exchange = null,
  tradeMode = null,
  signalId = null,
} = {}) {
  if (!symbol) return null;
  const conditions = [`symbol = $1`];
  const params = [symbol];

  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  const effectiveTradeMode = canonicalizePositionTradeMode(exchange, false, tradeMode);
  if (effectiveTradeMode) {
    params.push(effectiveTradeMode);
    conditions.push(`COALESCE(trade_mode, 'normal') = $${params.length}`);
  }
  if (signalId) {
    params.push(signalId);
    conditions.push(`signal_id = $${params.length}`);
  }

  params.push('active');
  conditions.push(`status = $${params.length}`);

  const row = await get(
    `SELECT * FROM position_strategy_profiles
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT 1`,
    params,
  );
  if (!row?.id) return null;
  const closedState = {
    lifecycleStatus: 'closed',
    latestRecommendation: 'CLOSED',
    latestReasonCode: 'position_closed',
    latestReason: 'position scope closed',
    closedAt: new Date().toISOString(),
    updatedBy: 'close_position_strategy_profile',
  };
  return get(
    `UPDATE position_strategy_profiles
     SET status = 'closed',
         strategy_state = COALESCE(strategy_state, '{}'::jsonb) || $2::jsonb,
         closed_at = now(),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [row.id, JSON.stringify(closedState)],
  );
}

// ─── agent_role_profiles / agent_role_state ─────────────────────────

export async function upsertAgentRoleProfile({
  agentId,
  team = 'investment',
  primaryRole,
  secondaryRoles = [],
  capabilities = [],
  defaultPriority = 50,
  metadata = {},
} = {}) {
  if (!agentId || !primaryRole) return null;
  return get(
    `INSERT INTO agent_role_profiles (
       agent_id, team, primary_role, secondary_roles, capabilities, default_priority, metadata, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       team = EXCLUDED.team,
       primary_role = EXCLUDED.primary_role,
       secondary_roles = EXCLUDED.secondary_roles,
       capabilities = EXCLUDED.capabilities,
       default_priority = EXCLUDED.default_priority,
       metadata = EXCLUDED.metadata,
       updated_at = now()
     RETURNING *`,
    [
      String(agentId),
      String(team || 'investment'),
      String(primaryRole),
      JSON.stringify(Array.isArray(secondaryRoles) ? secondaryRoles : []),
      JSON.stringify(Array.isArray(capabilities) ? capabilities : []),
      Math.max(0, Math.round(Number(defaultPriority || 50))),
      JSON.stringify(metadata || {}),
    ],
  );
}

export async function upsertAgentRoleState({
  agentId,
  team = 'investment',
  scopeType = 'global',
  scopeKey = 'investment',
  mission,
  roleMode,
  priority = 50,
  status = 'active',
  reason = null,
  state = {},
} = {}) {
  if (!agentId || !mission || !roleMode) return null;
  const updated = await get(
    `UPDATE agent_role_state
     SET team = $1,
         mission = $2,
         role_mode = $3,
         priority = $4,
         status = $5,
         reason = $6,
         state = $7::jsonb,
         updated_at = now()
     WHERE agent_id = $8
       AND scope_type = $9
       AND scope_key = $10
       AND status = 'active'
     RETURNING *`,
    [
      String(team || 'investment'),
      String(mission),
      String(roleMode),
      Math.max(0, Math.round(Number(priority || 50))),
      String(status || 'active'),
      reason ? String(reason) : null,
      JSON.stringify(state || {}),
      String(agentId),
      String(scopeType || 'global'),
      String(scopeKey || 'investment'),
    ],
  );
  if (updated) return updated;

  return get(
    `INSERT INTO agent_role_state (
       agent_id, team, scope_type, scope_key, mission, role_mode, priority, status, reason, state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      String(agentId),
      String(team || 'investment'),
      String(scopeType || 'global'),
      String(scopeKey || 'investment'),
      String(mission),
      String(roleMode),
      Math.max(0, Math.round(Number(priority || 50))),
      String(status || 'active'),
      reason ? String(reason) : null,
      JSON.stringify(state || {}),
    ],
  );
}

export async function getActiveAgentRoleStates({
  team = 'investment',
  scopeType = null,
  scopeKey = null,
  limit = 100,
} = {}) {
  const conditions = [`status = 'active'`, `team = $1`];
  const params = [String(team || 'investment')];
  if (scopeType) {
    params.push(String(scopeType));
    conditions.push(`scope_type = $${params.length}`);
  }
  if (scopeKey) {
    params.push(String(scopeKey));
    conditions.push(`scope_key = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 100)));
  return query(
    `SELECT *
     FROM agent_role_state
     WHERE ${conditions.join(' AND ')}
     ORDER BY priority DESC, updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function getAgentRoleState({
  agentId,
  team = 'investment',
  scopeType = 'market',
  scopeKey,
} = {}) {
  if (!agentId || !scopeKey) return null;
  return get(
    `SELECT *
     FROM agent_role_state
     WHERE status = 'active'
       AND team = $1
       AND agent_id = $2
       AND scope_type = $3
       AND scope_key = $4
     ORDER BY priority DESC, updated_at DESC
     LIMIT 1`,
    [
      String(team || 'investment'),
      String(agentId),
      String(scopeType || 'market'),
      String(scopeKey),
    ],
  );
}

// ─── risk_log ────────────────────────────────────────────────────────

export async function insertRiskLog({ traceId, symbol, exchange, decision, riskScore, reason }) {
  await run(
    `INSERT INTO risk_log (trace_id, symbol, exchange, decision, risk_score, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [traceId, symbol ?? null, exchange ?? null, decision, riskScore ?? null, reason ?? null],
  );
}

// ─── asset_snapshot ──────────────────────────────────────────────────

export async function insertAssetSnapshot(equity, valueUsd = null) {
  await run(`INSERT INTO asset_snapshot (equity, value_usd) VALUES ($1,$2)`, [equity, valueUsd]);
}

export async function getLatestEquity() {
  const row = await get(`SELECT equity FROM asset_snapshot ORDER BY snapped_at DESC LIMIT 1`);
  return row?.equity ?? null;
}

export async function getEquityHistory(limit = 200, options = {}) {
  const normalizedLimit = Math.max(1, Number.parseInt(String(limit), 10) || 200);
  const positiveOnly = options?.positiveOnly !== false;
  const since = options?.since ? new Date(options.since) : null;
  const params = [];
  const clauses = [];

  if (positiveOnly) {
    params.push(0);
    clauses.push(`equity > $${params.length}`);
  }

  if (since && !Number.isNaN(since.getTime())) {
    params.push(since.toISOString());
    clauses.push(`snapped_at >= $${params.length}`);
  }

  params.push(normalizedLimit);
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  return query(
    `SELECT equity, snapped_at FROM asset_snapshot ${whereClause} ORDER BY snapped_at ASC LIMIT $${params.length}`,
    params,
  );
}

// ─── market_regime_snapshots ────────────────────────────────────────

export async function insertMarketRegimeSnapshot({
  market,
  regime,
  confidence = 0.5,
  indicators = {},
} = {}) {
  if (!market || !regime) return null;
  return get(
    `INSERT INTO market_regime_snapshots (
       market,
       regime,
       confidence,
       indicators
     ) VALUES ($1, $2, $3, $4)
     RETURNING id, market, regime, confidence, indicators, captured_at`,
    [
      String(market),
      String(regime),
      Number(confidence || 0.5),
      JSON.stringify(indicators || {}),
    ],
  );
}

// ─── runtime_config_suggestion_log ───────────────────────────────────

export async function insertRuntimeConfigSuggestionLog({
  periodDays,
  actionableCount = 0,
  marketSummary,
  suggestions,
  policySnapshot = null,
  reviewStatus = 'pending',
  reviewNote = null,
}) {
  const row = await get(
    `INSERT INTO runtime_config_suggestion_log (
       period_days,
       actionable_count,
       market_summary,
       suggestions,
       policy_snapshot,
       review_status,
       review_note
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, captured_at`,
    [
      periodDays,
      actionableCount,
      JSON.stringify(marketSummary ?? {}),
      JSON.stringify(suggestions ?? []),
      JSON.stringify(policySnapshot ?? {}),
      reviewStatus,
      reviewNote,
    ],
  );
  return row || null;
}

export async function getRecentRuntimeConfigSuggestionLogs(limit = 10) {
  return query(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     ORDER BY captured_at DESC
     LIMIT $1`,
    [limit],
  );
}

export async function getRuntimeConfigSuggestionLogById(id) {
  return get(
    `SELECT id, period_days, actionable_count, market_summary, suggestions, policy_snapshot, review_status, review_note, reviewed_at, applied_at, captured_at
     FROM runtime_config_suggestion_log
     WHERE id = $1`,
    [id],
  );
}

/**
 * @param {string|number} id
 * @param {{ reviewStatus?: string, reviewNote?: string|null }} [input={}]
 * @returns {Promise<any>}
 */
export async function updateRuntimeConfigSuggestionLogReview(id, {
  reviewStatus,
  reviewNote = null,
} = {}) {
  if (!id || !reviewStatus) return null;

  const normalizedStatus = String(reviewStatus).trim().toLowerCase();
  const nowClause = `now()`;
  const appliedClause = normalizedStatus === 'applied' ? nowClause : 'NULL';

  return get(
    `UPDATE runtime_config_suggestion_log
     SET review_status = $1,
         review_note = $2,
         reviewed_at = ${nowClause},
         applied_at = ${appliedClause}
     WHERE id = $3
     RETURNING id, review_status, review_note, reviewed_at, applied_at, captured_at`,
    [normalizedStatus, reviewNote, id],
  );
}

// ─── position_lifecycle_events ───────────────────────────────────────

export async function insertLifecycleEvent({
  positionScopeKey,
  exchange,
  symbol,
  tradeMode = 'normal',
  phase,
  stageId = null,
  ownerAgent = null,
  eventType,
  inputSnapshot = {},
  outputSnapshot = {},
  policySnapshot = {},
  evidenceSnapshot = {},
  idempotencyKey = null,
}) {
  if (!positionScopeKey || !exchange || !symbol || !phase || !eventType) return null;
  if (idempotencyKey) {
    const existing = await get(
      `SELECT id FROM position_lifecycle_events WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(() => null);
    if (existing) return existing.id;
  }
  const row = await get(
    `INSERT INTO position_lifecycle_events
       (position_scope_key, exchange, symbol, trade_mode, phase, stage_id, owner_agent, event_type,
        input_snapshot, output_snapshot, policy_snapshot, evidence_snapshot, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      positionScopeKey, exchange, symbol, tradeMode || 'normal',
      phase, stageId || null, ownerAgent || null, eventType,
      JSON.stringify(inputSnapshot ?? {}),
      JSON.stringify(outputSnapshot ?? {}),
      JSON.stringify(policySnapshot ?? {}),
      JSON.stringify(evidenceSnapshot ?? {}),
      idempotencyKey || null,
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function getLifecycleEventsForScope(positionScopeKey, { limit = 50 } = {}) {
  return query(
    `SELECT * FROM position_lifecycle_events
     WHERE position_scope_key = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [positionScopeKey, limit],
  ).catch(() => []);
}

export async function getLifecyclePhaseCoverage({ days = 7 } = {}) {
  return query(
    `SELECT symbol, exchange, trade_mode,
            array_agg(DISTINCT phase ORDER BY phase) AS covered_phases,
            COUNT(*) AS event_count,
            MAX(created_at) AS last_event_at
     FROM position_lifecycle_events
     WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
     GROUP BY symbol, exchange, trade_mode
     ORDER BY last_event_at DESC`,
    [days],
  ).catch(() => []);
}

// ─── position_closeout_reviews ───────────────────────────────────────

export async function insertCloseoutReview({
  signalId = null,
  tradeId = null,
  journalId = null,
  exchange,
  symbol,
  tradeMode = 'normal',
  closeoutType,
  closeoutReason = null,
  plannedRatio = null,
  executedRatio = null,
  plannedNotional = null,
  executedNotional = null,
  slippagePct = null,
  feeTotal = null,
  pnlRealized = null,
  pnlRemainingUnrealized = null,
  regime = null,
  setupType = null,
  strategyFamily = null,
  familyBias = null,
  autonomyPhase = null,
  reviewStatus = 'pending',
  reviewResult = {},
  policySuggestions = [],
  idempotencyKey = null,
}) {
  if (!exchange || !symbol || !closeoutType) return null;
  if (idempotencyKey) {
    const existing = await get(
      `SELECT id FROM position_closeout_reviews WHERE idempotency_key = $1`,
      [idempotencyKey],
    ).catch(() => null);
    if (existing) return existing.id;
  }
  const row = await get(
    `INSERT INTO position_closeout_reviews
       (signal_id, trade_id, journal_id, exchange, symbol, trade_mode,
        closeout_type, closeout_reason, planned_ratio, executed_ratio,
        planned_notional, executed_notional, slippage_pct, fee_total,
        pnl_realized, pnl_remaining_unrealized, regime, setup_type,
        strategy_family, family_bias, autonomy_phase, review_status, review_result,
        policy_suggestions, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     RETURNING id`,
    [
      signalId || null, tradeId || null, journalId || null,
      exchange, symbol, tradeMode || 'normal',
      closeoutType, closeoutReason || null,
      plannedRatio != null ? Number(plannedRatio) : null,
      executedRatio != null ? Number(executedRatio) : null,
      plannedNotional != null ? Number(plannedNotional) : null,
      executedNotional != null ? Number(executedNotional) : null,
      slippagePct != null ? Number(slippagePct) : null,
      feeTotal != null ? Number(feeTotal) : null,
      pnlRealized != null ? Number(pnlRealized) : null,
      pnlRemainingUnrealized != null ? Number(pnlRemainingUnrealized) : null,
      regime || null, setupType || null,
      strategyFamily || null, familyBias || null,
      autonomyPhase || resolveLunaAutonomyPhase(Date.now()),
      reviewStatus || 'pending',
      JSON.stringify(reviewResult ?? {}),
      JSON.stringify(policySuggestions ?? []),
      idempotencyKey || null,
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function updateCloseoutReview(id, {
  reviewStatus,
  reviewResult = null,
  policySuggestions = null,
  executedRatio = null,
  executedNotional = null,
  slippagePct = null,
  pnlRealized = null,
  journalId = null,
  tradeId = null,
} = {}) {
  if (!id) return null;
  const sets = ['reviewed_at = now()'];
  const params = [];
  let idx = 1;
  if (reviewStatus != null) { sets.push(`review_status = $${idx++}`); params.push(reviewStatus); }
  if (reviewResult != null) { sets.push(`review_result = $${idx++}`); params.push(JSON.stringify(reviewResult)); }
  if (policySuggestions != null) { sets.push(`policy_suggestions = $${idx++}`); params.push(JSON.stringify(policySuggestions)); }
  if (executedRatio != null) { sets.push(`executed_ratio = $${idx++}`); params.push(Number(executedRatio)); }
  if (executedNotional != null) { sets.push(`executed_notional = $${idx++}`); params.push(Number(executedNotional)); }
  if (slippagePct != null) { sets.push(`slippage_pct = $${idx++}`); params.push(Number(slippagePct)); }
  if (pnlRealized != null) { sets.push(`pnl_realized = $${idx++}`); params.push(Number(pnlRealized)); }
  if (journalId != null) { sets.push(`journal_id = $${idx++}`); params.push(String(journalId)); }
  if (tradeId != null) { sets.push(`trade_id = $${idx++}`); params.push(String(tradeId)); }
  params.push(id);
  return get(
    `UPDATE position_closeout_reviews SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, review_status`,
    params,
  ).catch(() => null);
}

export async function getRecentCloseoutReviews({ days = 30, symbol = null, exchange = null, limit = 100 } = {}) {
  const conds = [`created_at >= now() - ($1::int * INTERVAL '1 day')`];
  const params = [days];
  if (symbol) { conds.push(`symbol = $${params.length + 1}`); params.push(symbol); }
  if (exchange) { conds.push(`exchange = $${params.length + 1}`); params.push(exchange); }
  params.push(limit);
  return query(
    `SELECT * FROM position_closeout_reviews WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

// ─── external_evidence_events ─────────────────────────────────────────

export async function insertExternalEvidence({
  sourceType,
  sourceName = null,
  sourceUrl = null,
  symbol = null,
  market = null,
  strategyFamily = null,
  signalDirection = null,
  score = 0,
  sourceQuality = 0.5,
  freshnessScore = 1.0,
  evidenceSummary = null,
  rawRef = {},
}) {
  if (!sourceType) return null;
  const row = await get(
    `INSERT INTO external_evidence_events
       (source_type, source_name, source_url, symbol, market, strategy_family,
        signal_direction, score, source_quality, freshness_score, evidence_summary, raw_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      sourceType, sourceName || null, sourceUrl || null,
      symbol || null, market || null, strategyFamily || null,
      signalDirection || null,
      Number(score || 0), Number(sourceQuality || 0.5), Number(freshnessScore || 1.0),
      evidenceSummary || null, JSON.stringify(rawRef ?? {}),
    ],
  ).catch(() => null);
  return row?.id || null;
}

export async function getRecentExternalEvidence({ days = 7, symbol = null, sourceType = null, limit = 50 } = {}) {
  const conds = [`created_at >= now() - ($1::int * INTERVAL '1 day')`];
  const params = [days];
  if (symbol) { conds.push(`symbol = $${params.length + 1}`); params.push(symbol); }
  if (sourceType) { conds.push(`source_type = $${params.length + 1}`); params.push(sourceType); }
  params.push(limit);
  return query(
    `SELECT * FROM external_evidence_events WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

// ─── position_signal_history ─────────────────────────────────────────

export async function insertPositionSignalHistory({
  positionScopeKey,
  exchange,
  symbol,
  tradeMode = 'normal',
  source = 'signal_refresh',
  eventType = 'signal_refresh',
  confidence = 0,
  sentimentScore = 0,
  evidenceSnapshot = {},
  qualityFlags = [],
} = {}) {
  if (!positionScopeKey || !exchange || !symbol) return null;
  const row = await get(
    `INSERT INTO position_signal_history
       (position_scope_key, exchange, symbol, trade_mode, source, event_type,
        confidence, sentiment_score, evidence_snapshot, quality_flags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, created_at`,
    [
      positionScopeKey,
      exchange,
      symbol,
      tradeMode || 'normal',
      source || 'signal_refresh',
      eventType || 'signal_refresh',
      Number(confidence || 0),
      Number(sentimentScore || 0),
      JSON.stringify(evidenceSnapshot || {}),
      JSON.stringify(Array.isArray(qualityFlags) ? qualityFlags : []),
    ],
  ).catch(() => null);
  return row || null;
}

export async function getRecentPositionSignalHistory({
  symbol = null,
  exchange = null,
  positionScopeKey = null,
  source = null,
  limit = 50,
} = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (symbol) {
    params.push(symbol);
    conditions.push(`symbol = $${params.length}`);
  }
  if (exchange) {
    params.push(exchange);
    conditions.push(`exchange = $${params.length}`);
  }
  if (positionScopeKey) {
    params.push(positionScopeKey);
    conditions.push(`position_scope_key = $${params.length}`);
  }
  if (source) {
    params.push(source);
    conditions.push(`source = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 50)));
  return query(
    `SELECT *
     FROM position_signal_history
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

// ─── posttrade feedback loop (A~H) ──────────────────────────────────

export async function fetchPendingPosttradeKnowledgeEvents({ limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.round(Number(limit || 20)));
  return query(
    `SELECT
       mk.id AS knowledge_id,
       mk.created_at,
       mk.payload,
       CASE WHEN mk.payload->>'trade_id' ~ '^[0-9]+$'
            THEN (mk.payload->>'trade_id')::BIGINT
            ELSE NULL
       END AS trade_id
     FROM investment.mapek_knowledge mk
     WHERE mk.event_type = 'quality_evaluation_pending'
       AND COALESCE(mk.payload->>'posttrade_processed', 'false') <> 'true'
       AND mk.payload->>'trade_id' ~ '^[0-9]+$'
     ORDER BY mk.created_at ASC
     LIMIT $1`,
    [safeLimit],
  ).catch(() => []);
}

export async function markPosttradeKnowledgeEventProcessed(knowledgeId, metadata = {}) {
  if (!knowledgeId) return null;
  const row = await get(
    `UPDATE investment.mapek_knowledge
        SET payload = COALESCE(payload, '{}'::jsonb)
          || jsonb_build_object(
            'posttrade_processed', true,
            'posttrade_processed_at', NOW()::text,
            'posttrade_process_meta', $2::jsonb
          )
      WHERE id = $1
      RETURNING id`,
    [knowledgeId, JSON.stringify(metadata || {})],
  ).catch(() => null);
  return row?.id || null;
}

export async function insertFeedbackToActionMap({
  sourceTradeId = null,
  parameterName,
  oldValue = null,
  newValue = null,
  reason = null,
  suggestionLogId = null,
  metadata = {},
} = {}) {
  if (!parameterName) return null;
  const row = await get(
    `INSERT INTO feedback_to_action_map
       (source_trade_id, parameter_name, old_value, new_value, reason, suggestion_log_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, applied_at`,
    [
      sourceTradeId ? Number(sourceTradeId) : null,
      String(parameterName),
      JSON.stringify(oldValue),
      JSON.stringify(newValue),
      reason || null,
      suggestionLogId || null,
      JSON.stringify(metadata || {}),
    ],
  ).catch(() => null);
  return row || null;
}

export async function recordFeedbackToActionMap(payload = {}) {
  return insertFeedbackToActionMap(payload);
}

export async function getRecentFeedbackToActionMap({ days = 7, market = null, limit = 100 } = {}) {
  const params = [Math.max(1, Math.round(Number(days || 7))), Math.max(1, Math.round(Number(limit || 100)))];
  const clauses = [`fam.applied_at >= NOW() - ($1::int * INTERVAL '1 day')`];
  if (market) {
    params.push(String(market));
    clauses.push(`COALESCE(th.market, CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END) = $${params.length}`);
  }
  try {
    return await query(
    `SELECT fam.*, th.symbol, th.exchange, th.market
       FROM feedback_to_action_map fam
       LEFT JOIN investment.trade_history th ON th.id = fam.source_trade_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY fam.applied_at DESC
      LIMIT $2`,
    params,
    );
  } catch (error) {
    const message = String(error?.message || error || '');
    if (message.includes('trade_history') || message.includes('does not exist')) {
      if (market) return [];
      return query(
        `SELECT fam.*
           FROM feedback_to_action_map fam
          WHERE fam.applied_at >= NOW() - ($1::int * INTERVAL '1 day')
          ORDER BY fam.applied_at DESC
          LIMIT $2`,
        [params[0], params[1]],
      ).catch(() => []);
    }
    return [];
  }
}

export async function upsertPosttradeSkill({
  market = 'all',
  skillType = 'success',
  patternKey,
  title,
  summary,
  invocationCount = 0,
  successRate = 0,
  winCount = 0,
  lossCount = 0,
  sourceTradeIds = [],
  metadata = {},
} = {}) {
  if (!patternKey || !title || !summary) return null;
  const row = await get(
    `INSERT INTO luna_posttrade_skills
       (market, skill_type, pattern_key, title, summary, invocation_count, success_rate, win_count, loss_count, source_trade_ids, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (market, skill_type, pattern_key)
     DO UPDATE SET
       title = EXCLUDED.title,
       summary = EXCLUDED.summary,
       invocation_count = EXCLUDED.invocation_count,
       success_rate = EXCLUDED.success_rate,
       win_count = EXCLUDED.win_count,
       loss_count = EXCLUDED.loss_count,
       source_trade_ids = EXCLUDED.source_trade_ids,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, market, skill_type, pattern_key, updated_at`,
    [
      String(market || 'all'),
      String(skillType || 'success'),
      String(patternKey),
      String(title),
      String(summary),
      Math.max(0, Math.round(Number(invocationCount || 0))),
      Number(successRate || 0),
      Math.max(0, Math.round(Number(winCount || 0))),
      Math.max(0, Math.round(Number(lossCount || 0))),
      JSON.stringify(Array.isArray(sourceTradeIds) ? sourceTradeIds : []),
      JSON.stringify(metadata || {}),
    ],
  ).catch(() => null);
  return row || null;
}

export async function getRecentPosttradeSkills({ market = null, skillType = null, limit = 50 } = {}) {
  const params = [];
  const where = [];
  if (market) {
    params.push(String(market));
    where.push(`market = $${params.length}`);
  }
  if (skillType) {
    params.push(String(skillType));
    where.push(`skill_type = $${params.length}`);
  }
  params.push(Math.max(1, Math.round(Number(limit || 50))));
  return query(
    `SELECT *
       FROM luna_posttrade_skills
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY success_rate DESC, updated_at DESC
      LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

export async function cleanupPosttradeSmokeArtifacts({ apply = false } = {}) {
  const summary = {
    apply: apply === true,
    feedbackToActionRows: 0,
    suggestionLogs: 0,
    posttradeSkills: 0,
    knowledgeRows: 0,
  };

  const suggestionRows = await query(
    `SELECT id
       FROM runtime_config_suggestion_log
      WHERE market_summary->>'smoke' = 'true'
         OR COALESCE(review_note, '') ILIKE '%posttrade audit smoke%'
         OR suggestions::text ILIKE '%runtime_config.posttrade.smoke.%'`,
    [],
  ).catch(() => []);
  const suggestionIds = (suggestionRows || []).map((row) => String(row.id)).filter(Boolean);
  summary.suggestionLogs = suggestionIds.length;

  const feedbackRows = await query(
    `SELECT id
       FROM feedback_to_action_map
      WHERE metadata->>'smoke' = 'true'
         OR parameter_name LIKE 'runtime_config.posttrade.smoke.%'
         OR COALESCE(reason, '') ILIKE '%smoke%'
         OR (${suggestionIds.length > 0 ? 'suggestion_log_id = ANY($1::text[])' : 'false'})`,
    suggestionIds.length > 0 ? [suggestionIds] : [],
  ).catch(() => []);
  summary.feedbackToActionRows = (feedbackRows || []).length;

  const skillRows = await query(
    `SELECT id
       FROM luna_posttrade_skills
      WHERE metadata->>'smoke' = 'true'
         OR pattern_key LIKE '%:smoke_%'
         OR pattern_key LIKE '%:mirror_smoke:%'
         OR summary ILIKE '%smoke%'`,
    [],
  ).catch(() => []);
  summary.posttradeSkills = (skillRows || []).length;

  const knowledgeRows = await query(
    `SELECT id
       FROM investment.mapek_knowledge
      WHERE event_type IN ('quality_evaluation_pending', 'posttrade_quality_evaluated')
        AND (
          payload->>'smoke' = 'true'
          OR payload->>'source' = 'posttrade_smoke'
          OR payload->>'trade_id' LIKE '90%'
        )`,
    [],
  ).catch(() => []);
  summary.knowledgeRows = (knowledgeRows || []).length;

  if (apply !== true) return summary;

  await run(
    `DELETE FROM feedback_to_action_map
      WHERE metadata->>'smoke' = 'true'
         OR parameter_name LIKE 'runtime_config.posttrade.smoke.%'
         OR COALESCE(reason, '') ILIKE '%smoke%'
         OR (${suggestionIds.length > 0 ? 'suggestion_log_id = ANY($1::text[])' : 'false'})`,
    suggestionIds.length > 0 ? [suggestionIds] : [],
  ).catch(() => {});
  await run(
    `DELETE FROM runtime_config_suggestion_log
      WHERE market_summary->>'smoke' = 'true'
         OR COALESCE(review_note, '') ILIKE '%posttrade audit smoke%'
         OR suggestions::text ILIKE '%runtime_config.posttrade.smoke.%'`,
    [],
  ).catch(() => {});
  await run(
    `DELETE FROM luna_posttrade_skills
      WHERE metadata->>'smoke' = 'true'
         OR pattern_key LIKE '%:smoke_%'
         OR pattern_key LIKE '%:mirror_smoke:%'
         OR summary ILIKE '%smoke%'`,
    [],
  ).catch(() => {});
  await run(
    `DELETE FROM investment.mapek_knowledge
      WHERE event_type IN ('quality_evaluation_pending', 'posttrade_quality_evaluated')
        AND (
          payload->>'smoke' = 'true'
          OR payload->>'source' = 'posttrade_smoke'
          OR payload->>'trade_id' LIKE '90%'
        )`,
    [],
  ).catch(() => {});

  return summary;
}

export function close() {
  // pgPool 관리 — 개별 close 불필요 (pgPool.closeAll()로 전체 종료)
}

export default {
  query, run, get, withTransaction, initSchema,
  insertAnalysis, getRecentAnalysis,
  insertSignal, updateSignalStatus, updateSignalApproval, updateSignalAmount, updateSignalBlock, getSignalById, getPendingSignals, getApprovedSignals,
  insertTrade, getTradeHistory, getLatestTradeBySignalId, getSameDayTrade,
  upsertPosition, getPosition, getLivePosition, getPaperPosition, getAllPositions, getPaperPositions, getOpenPositions, deletePosition,
  getTodayPnl,
  insertScreeningHistory,
  getRecentScreeningSymbols,
  upsertStrategy, getActiveStrategies, recordStrategyResult,
  getLatestVectorbtBacktestForSymbol, getLatestMarketRegimeSnapshot,
  getPositionStrategyProfile, getActivePositionStrategyProfiles, upsertPositionStrategyProfile, updatePositionStrategyProfileState, closePositionStrategyProfile,
  upsertAgentRoleProfile, upsertAgentRoleState, getActiveAgentRoleStates, getAgentRoleState,
  insertRiskLog,
  insertAssetSnapshot, getLatestEquity, getEquityHistory,
  insertMarketRegimeSnapshot,
  insertRuntimeConfigSuggestionLog, getRecentRuntimeConfigSuggestionLogs,
  getRuntimeConfigSuggestionLogById, updateRuntimeConfigSuggestionLogReview,
  insertLifecycleEvent, getLifecycleEventsForScope, getLifecyclePhaseCoverage,
  insertCloseoutReview, updateCloseoutReview, getRecentCloseoutReviews,
  insertExternalEvidence, getRecentExternalEvidence,
  insertPositionSignalHistory, getRecentPositionSignalHistory,
  fetchPendingPosttradeKnowledgeEvents, markPosttradeKnowledgeEventProcessed,
  insertFeedbackToActionMap, recordFeedbackToActionMap, getRecentFeedbackToActionMap,
  upsertPosttradeSkill, getRecentPosttradeSkills,
  close,
};
