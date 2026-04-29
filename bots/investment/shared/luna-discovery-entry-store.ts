// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');
const { createSchemaDbHelpers } = require('../../../packages/core/lib/db/helpers');

const db = createSchemaDbHelpers(pgPool, 'investment');
let _ensured = false;

function json(value, fallback = {}) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

export async function ensureLunaDiscoveryEntryTables() {
  if (_ensured) return;
	  await db.run(`
	    CREATE TABLE IF NOT EXISTS entry_triggers (
	      id                  TEXT PRIMARY KEY,
      symbol              TEXT NOT NULL,
      exchange            TEXT NOT NULL,
      setup_type          TEXT,
      trigger_type        TEXT NOT NULL,
      trigger_state       TEXT NOT NULL DEFAULT 'armed',
      confidence          DOUBLE PRECISION DEFAULT 0.5,
      target_price        DOUBLE PRECISION,
      stop_loss           DOUBLE PRECISION,
      take_profit         DOUBLE PRECISION,
      waiting_for         TEXT,
      trigger_context     JSONB DEFAULT '{}'::jsonb,
      trigger_meta        JSONB DEFAULT '{}'::jsonb,
      predictive_score    DOUBLE PRECISION,
      expires_at          TIMESTAMPTZ,
      fired_at            TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT now(),
      updated_at          TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_entry_triggers_scope
      ON entry_triggers(symbol, exchange, trigger_state, created_at DESC)
  `).catch(() => {});
  await db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_triggers_active_unique
      ON entry_triggers(symbol, exchange, trigger_type)
      WHERE trigger_state IN ('armed', 'waiting')
  `).catch(() => {});

	  await db.run(`
	    CREATE TABLE IF NOT EXISTS discovery_source_metrics (
	      id                 TEXT PRIMARY KEY,
      source             TEXT NOT NULL,
      market             TEXT NOT NULL,
      quality_status     TEXT DEFAULT 'ready',
      signal_count       INTEGER DEFAULT 0,
      reliability        DOUBLE PRECISION DEFAULT 0.5,
      freshness_score    DOUBLE PRECISION DEFAULT 1.0,
      confidence_score   DOUBLE PRECISION DEFAULT 0.5,
      notes              TEXT,
      raw_meta           JSONB DEFAULT '{}'::jsonb,
      captured_at        TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_discovery_source_metrics_scope
      ON discovery_source_metrics(source, market, captured_at DESC)
  `).catch(() => {});

	  await db.run(`
	    CREATE TABLE IF NOT EXISTS unmapped_news_events (
	      id                 TEXT PRIMARY KEY,
      market             TEXT,
      headline           TEXT NOT NULL,
      source             TEXT,
      confidence         DOUBLE PRECISION DEFAULT 0,
      reason             TEXT,
      event_meta         JSONB DEFAULT '{}'::jsonb,
      created_at         TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_unmapped_news_events_created ON unmapped_news_events(created_at DESC)`).catch(() => {});

  try {
    await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION DEFAULT 0.5`);
    await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS reason_code TEXT`);
    await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS evidence_ref JSONB DEFAULT '{}'::jsonb`);
    await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS quality_flags JSONB DEFAULT '[]'::jsonb`);
    await db.run(`ALTER TABLE candidate_universe ADD COLUMN IF NOT EXISTS ttl_hours INTEGER DEFAULT 24`);
  } catch {
    // no-op
  }
  _ensured = true;
}

export async function insertEntryTrigger({
  symbol,
  exchange,
  setupType = null,
  triggerType = 'breakout_confirmation',
  triggerState = 'armed',
  confidence = 0.5,
  targetPrice = null,
  stopLoss = null,
  takeProfit = null,
  waitingFor = null,
  triggerContext = {},
  triggerMeta = {},
  predictiveScore = null,
  expiresAt = null,
} = {}) {
  if (!symbol || !exchange) return null;
  await ensureLunaDiscoveryEntryTables();
	  const params = [
	    randomUUID(),
	    symbol,
	    exchange,
    setupType,
    triggerType,
    triggerState,
    Number(confidence || 0.5),
    targetPrice != null ? Number(targetPrice) : null,
    stopLoss != null ? Number(stopLoss) : null,
    takeProfit != null ? Number(takeProfit) : null,
    waitingFor,
    json(triggerContext, {}),
    json(triggerMeta, {}),
    predictiveScore != null ? Number(predictiveScore) : null,
    expiresAt || null,
  ];
	  let row = await db.get(
	    `UPDATE entry_triggers
	        SET setup_type = $4,
	            trigger_state = $6,
	            confidence = $7,
	            target_price = $8,
	            stop_loss = $9,
	            take_profit = $10,
	            waiting_for = $11,
	            trigger_context = $12::jsonb,
	            trigger_meta = $13::jsonb,
	            predictive_score = $14,
	            expires_at = $15,
	            updated_at = now()
	      WHERE symbol = $2
	        AND exchange = $3
	        AND trigger_type = $5
	        AND trigger_state IN ('armed', 'waiting')
	      RETURNING *`,
	    params,
	  ).catch(() => null);
	  if (!row) {
	    row = await db.get(
	      `INSERT INTO entry_triggers
	         (id, symbol, exchange, setup_type, trigger_type, trigger_state, confidence, target_price, stop_loss, take_profit, waiting_for, trigger_context, trigger_meta, predictive_score, expires_at, updated_at)
	       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,now())
	       RETURNING *`,
	      params,
	    ).catch(() => null);
  }
  return row;
}

export async function listActiveEntryTriggers({
  exchange = null,
  symbol = null,
  states = ['armed', 'waiting'],
  limit = 500,
} = {}) {
  await ensureLunaDiscoveryEntryTables();
  const conds = [`trigger_state = ANY($1)`];
  const params = [states];
  if (exchange) {
    params.push(exchange);
    conds.push(`exchange = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol);
    conds.push(`symbol = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 500)));
  return db.query(
    `SELECT * FROM entry_triggers
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at ASC
      LIMIT $${params.length}`,
    params,
  ).catch(() => []);
}

export async function updateEntryTriggerState(id, {
  triggerState,
  firedAt = null,
  predictiveScore = null,
  triggerMetaPatch = null,
} = {}) {
  if (!id || !triggerState) return null;
  await ensureLunaDiscoveryEntryTables();
  const sets = ['trigger_state = $1', 'updated_at = now()'];
  const params = [triggerState];
  if (firedAt) {
    params.push(firedAt);
    sets.push(`fired_at = $${params.length}`);
  }
  if (predictiveScore != null) {
    params.push(Number(predictiveScore));
    sets.push(`predictive_score = $${params.length}`);
  }
  if (triggerMetaPatch && typeof triggerMetaPatch === 'object') {
    params.push(json(triggerMetaPatch, {}));
    sets.push(`trigger_meta = COALESCE(trigger_meta, '{}'::jsonb) || $${params.length}::jsonb`);
  }
  params.push(id);
  return db.get(
    `UPDATE entry_triggers SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params,
  ).catch(() => null);
}

export async function getRecentFiredEntryTrigger({
  symbol,
  exchange,
  triggerType,
  minutes = 10,
} = {}) {
  if (!symbol || !exchange || !triggerType) return null;
  await ensureLunaDiscoveryEntryTables();
  return db.get(
    `SELECT *
       FROM entry_triggers
      WHERE symbol = $1
        AND exchange = $2
        AND trigger_type = $3
        AND trigger_state = 'fired'
        AND fired_at >= now() - ($4::int * INTERVAL '1 minute')
      ORDER BY fired_at DESC
      LIMIT 1`,
    [symbol, exchange, triggerType, Math.max(1, Number(minutes || 10))],
  ).catch(() => null);
}

export async function expireEntryTriggers({ nowIso = null } = {}) {
  await ensureLunaDiscoveryEntryTables();
  const row = await db.get(
    `WITH updated AS (
       UPDATE entry_triggers
          SET trigger_state = 'expired',
              updated_at = now()
        WHERE trigger_state IN ('armed', 'waiting')
          AND expires_at IS NOT NULL
          AND expires_at <= COALESCE($1::timestamptz, now())
      RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM updated`,
    [nowIso || null],
  ).catch(() => ({ count: 0 }));
  return Number(row?.count || 0);
}

export async function insertDiscoverySourceMetric({
  source,
  market,
  qualityStatus = 'ready',
  signalCount = 0,
  reliability = 0.5,
  freshnessScore = 1,
  confidenceScore = 0.5,
  notes = null,
  rawMeta = {},
} = {}) {
  if (!source || !market) return null;
  await ensureLunaDiscoveryEntryTables();
	  return db.get(
	    `INSERT INTO discovery_source_metrics
	      (id, source, market, quality_status, signal_count, reliability, freshness_score, confidence_score, notes, raw_meta)
	     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	     RETURNING id`,
	    [
	      randomUUID(),
	      source,
	      market,
      qualityStatus,
      Math.max(0, Math.round(Number(signalCount || 0))),
      Number(reliability || 0.5),
      Number(freshnessScore || 1),
      Number(confidenceScore || 0.5),
      notes || null,
      json(rawMeta, {}),
    ],
  ).catch(() => null);
}

export async function insertDiscoveryComponentSnapshotMetrics({
  market,
  symbol = null,
  snapshot = null,
  quality = null,
  sourcePrefix = 'luna_component',
} = {}) {
  if (!market || !snapshot) return [];
  const integrated = snapshot.integratedScore || {};
  const components = [
    {
      source: `${sourcePrefix}:sentiment`,
      qualityStatus: snapshot.sentiment?.status || 'unknown',
      signalCount: Number(snapshot.sentiment?.sourceCount || 0),
      reliability: Number(snapshot.sentiment?.confidence ?? quality?.componentQuality?.sentiment ?? 0.5),
      confidenceScore: Number(snapshot.sentiment?.confidence ?? 0.5),
      notes: integrated.reasonCodes?.includes?.('sentiment_source_missing') ? 'sentiment_source_missing' : null,
      rawMeta: { symbol, component: snapshot.sentiment, integrated },
    },
    {
      source: `${sourcePrefix}:technical`,
      qualityStatus: integrated.reasonCodes?.includes?.('technical_source_missing') ? 'missing' : 'ready',
      signalCount: Number(snapshot.technical?.sourceCount || 0),
      reliability: Number(snapshot.technical?.confidence ?? 0.5),
      confidenceScore: Number(snapshot.technical?.confidence ?? 0.5),
      notes: integrated.reasonCodes?.includes?.('technical_sentiment_divergence') ? 'technical_sentiment_divergence' : null,
      rawMeta: { symbol, component: snapshot.technical, integrated },
    },
    {
      source: `${sourcePrefix}:market_recognition`,
      qualityStatus: snapshot.marketRecognition?.risk === 'elevated' ? 'attention' : 'ready',
      signalCount: 1,
      reliability: snapshot.marketRecognition?.risk === 'elevated' ? 0.6 : 1,
      confidenceScore: snapshot.marketRecognition?.risk === 'elevated' ? 0.6 : 1,
      notes: snapshot.marketRecognition?.regime || null,
      rawMeta: { symbol, component: snapshot.marketRecognition, integrated },
    },
    {
      source: `${sourcePrefix}:integrated_score`,
      qualityStatus: quality?.qualityStatus || integrated.decisionState || 'unknown',
      signalCount: 1,
      reliability: Number(integrated.adjustedScore ?? integrated.rawScore ?? 0.5),
      confidenceScore: Number(integrated.adjustedScore ?? integrated.rawScore ?? 0.5),
      notes: (integrated.reasonCodes || []).join(',') || null,
      rawMeta: { symbol, integrated, quality },
    },
  ];
  const rows = [];
  for (const item of components) {
    rows.push(await insertDiscoverySourceMetric({ market, ...item }));
  }
  return rows;
}

export async function insertUnmappedNewsEvent({
  market = null,
  headline,
  source = null,
  confidence = 0,
  reason = null,
  eventMeta = {},
} = {}) {
  if (!headline) return null;
  await ensureLunaDiscoveryEntryTables();
	  return db.get(
	    `INSERT INTO unmapped_news_events
	      (id, market, headline, source, confidence, reason, event_meta)
	     VALUES ($1,$2,$3,$4,$5,$6,$7)
	     RETURNING id`,
	    [randomUUID(), market, String(headline).slice(0, 500), source, Number(confidence || 0), reason, json(eventMeta, {})],
	  ).catch(() => null);
	}

export async function getRecentUnmappedNewsEvents({ hours = 24, limit = 100 } = {}) {
  await ensureLunaDiscoveryEntryTables();
  return db.query(
    `SELECT *
       FROM unmapped_news_events
      WHERE created_at >= now() - ($1::int * INTERVAL '1 hour')
      ORDER BY created_at DESC
      LIMIT $2`,
    [Math.max(1, Number(hours || 24)), Math.max(1, Number(limit || 100))],
  ).catch(() => []);
}

export async function getEntryTriggerOperationalStats({
  exchange = null,
  hours = 24,
  duplicateWindowMinutes = 10,
  limit = 50,
} = {}) {
  await ensureLunaDiscoveryEntryTables();
  const scopeConds = [];
  const scopeParams = [];
  if (exchange) {
    scopeParams.push(exchange);
    scopeConds.push(`exchange = $${scopeParams.length}`);
  }
  const scopeWhere = scopeConds.length ? `WHERE ${scopeConds.join(' AND ')}` : '';
  const stateRows = await db.query(
    `SELECT trigger_state, COUNT(*)::int AS count
       FROM entry_triggers
       ${scopeWhere}
      GROUP BY trigger_state
      ORDER BY trigger_state`,
    scopeParams,
  ).catch(() => []);

  const recentParams = [...scopeParams, Math.max(1, Number(hours || 24))];
  const recentWhere = [
    ...scopeConds,
    `COALESCE(fired_at, updated_at, created_at) >= now() - ($${recentParams.length}::int * INTERVAL '1 hour')`,
  ].join(' AND ');

  const duplicateParams = [...scopeParams, Math.max(1, Number(duplicateWindowMinutes || 10))];
  const duplicateWhere = [
    ...scopeConds,
    `COALESCE(fired_at, updated_at, created_at) >= now() - ($${duplicateParams.length}::int * INTERVAL '1 minute')`,
  ].join(' AND ');
  const duplicateRows = await db.query(
    `SELECT symbol, exchange, trigger_type, COUNT(*)::int AS count, MAX(fired_at) AS last_fired_at
       FROM entry_triggers
      WHERE ${duplicateWhere}
        AND trigger_state = 'fired'
      GROUP BY symbol, exchange, trigger_type
     HAVING COUNT(*) > 1
      ORDER BY count DESC, last_fired_at DESC
      LIMIT $${duplicateParams.length + 1}`,
    [...duplicateParams, Math.max(1, Number(limit || 50))],
  ).catch(() => []);

  const recentRows = await db.query(
    `SELECT trigger_state, COUNT(*)::int AS count
       FROM entry_triggers
      WHERE ${recentWhere}
      GROUP BY trigger_state
      ORDER BY trigger_state`,
    recentParams,
  ).catch(() => []);

  const latestRows = await db.query(
    `SELECT id, symbol, exchange, trigger_type, trigger_state, confidence, fired_at, updated_at, created_at
       FROM entry_triggers
       ${scopeWhere}
      ORDER BY COALESCE(fired_at, updated_at, created_at) DESC
      LIMIT $${scopeParams.length + 1}`,
    [...scopeParams, Math.max(1, Number(limit || 50))],
  ).catch(() => []);

  const byState = Object.fromEntries((stateRows || []).map((row) => [row.trigger_state || 'unknown', Number(row.count || 0)]));
  const recentByState = Object.fromEntries((recentRows || []).map((row) => [row.trigger_state || 'unknown', Number(row.count || 0)]));
  return {
    exchange: exchange || 'all',
    hours: Math.max(1, Number(hours || 24)),
    duplicateWindowMinutes: Math.max(1, Number(duplicateWindowMinutes || 10)),
    byState,
    recentByState,
    activeCount: Number(byState.armed || 0) + Number(byState.waiting || 0),
    duplicateFiredScopes: duplicateRows || [],
    duplicateFiredScopeCount: (duplicateRows || []).length,
    latest: latestRows || [],
  };
}

export default {
  ensureLunaDiscoveryEntryTables,
  insertEntryTrigger,
  listActiveEntryTriggers,
  updateEntryTriggerState,
  getRecentFiredEntryTrigger,
  expireEntryTriggers,
  insertDiscoverySourceMetric,
  insertDiscoveryComponentSnapshotMetrics,
  insertUnmappedNewsEvent,
  getRecentUnmappedNewsEvents,
  getEntryTriggerOperationalStats,
};
