#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { callViaHub } from '../shared/hub-llm-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const VALID_MARKETS = new Set(['crypto', 'domestic', 'overseas']);
const CONFIRM_TOKEN = 'luna-regime-llm-shadow';

function parseArgs(argv = process.argv.slice(2)) {
  const value = (name, fallback = null) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
  };
  const markets = String(value('markets', 'crypto,domestic,overseas'))
    .split(',')
    .map(normalizeMarket)
    .filter(Boolean);
  return {
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
    confirm: value('confirm', ''),
    ttlMinutes: Math.max(15, Number(value('ttl-minutes', 360)) || 360),
    markets: [...new Set(markets.length ? markets : ['crypto', 'domestic', 'overseas'])],
  };
}

function normalizeMarket(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return VALID_MARKETS.has(raw) ? raw : null;
}

function toNumber(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nowMs() {
  return Date.now();
}

async function latestRuleSnapshot(market) {
  const rows = await db.query(
    `SELECT market, regime, confidence, indicators, captured_at
       FROM investment.market_regime_snapshots
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  );
  const row = rows?.[0] || null;
  if (!row) return null;
  return {
    market,
    regime: row.regime || 'unknown',
    confidence: toNumber(row.confidence, 0.5),
    indicators: row.indicators || {},
    capturedAt: row.captured_at || null,
  };
}

async function latestShadowSnapshot(market) {
  const rows = await db.query(
    `SELECT market, rule_regime, llm_regime, llm_confidence, match, captured_at
       FROM investment.luna_regime_llm_shadow
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  ).catch(() => []);
  return rows?.[0] || null;
}

function shadowFreshEnough({ shadow, rule, ttlMinutes, force }) {
  if (force || !shadow?.captured_at) return false;
  const ageMs = nowMs() - new Date(shadow.captured_at).getTime();
  const withinTtl = ageMs >= 0 && ageMs < ttlMinutes * 60 * 1000;
  const sameRuleRegime = String(shadow.rule_regime || '') === String(rule?.regime || '');
  return withinTtl && sameRuleRegime;
}

function formatIndicators(indicators = {}) {
  const evidence = indicators.evidence || indicators.snapshots || [];
  if (Array.isArray(evidence) && evidence.length > 0) {
    return evidence.slice(0, 8).map((item) => {
      const label = item.label || item.symbol || item.source || '?';
      const day = Number(item.dayChangePct ?? item.day_change_pct ?? 0);
      const trend = Number(item.trendPct ?? item.trend_pct ?? 0);
      return `- ${label}: day=${Number.isFinite(day) ? day.toFixed(2) : 'n/a'}%, trend=${Number.isFinite(trend) ? trend.toFixed(2) : 'n/a'}%`;
    }).join('\n');
  }
  return JSON.stringify(indicators || {}).slice(0, 1200) || '지표 데이터 없음';
}

function buildPrompt(rule) {
  const confidencePct = Math.round(toNumber(rule.confidence, 0.5) * 1000) / 10;
  return [
    '너는 Luna Phase 1 시장 체제 Shadow 분석기다.',
    '실거래 결정권은 없고, 규칙 기반 결과와 비교할 LLM 관찰값만 JSON으로 반환한다.',
    '',
    `[market] ${rule.market}`,
    `[rule_regime] ${rule.regime}`,
    `[rule_confidence] ${confidencePct}%`,
    '',
    '[indicators]',
    formatIndicators(rule.indicators),
    '',
    '분류값은 trending_bull, trending_bear, ranging, volatile, unknown 중 하나만 사용한다.',
    '응답은 코드블록 없이 JSON 객체만 출력한다.',
    '{"regime":"ranging","confidence":55,"rationale":"한 문장 근거","duration_estimate":"단기(1-3일)","key_signals":["신호1","신호2"]}',
  ].join('\n');
}

function extractJson(text = '') {
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('json_not_found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeLlmResult(text) {
  const parsed = extractJson(text);
  const regime = normalizeRegime(parsed.regime);
  return {
    regime,
    confidence: normalizeLlmConfidence(parsed.confidence, 0.5),
    rationale: String(parsed.rationale || '').slice(0, 1000),
    durationEstimate: String(parsed.duration_estimate || parsed.duration || '단기').slice(0, 200),
    keySignals: Array.isArray(parsed.key_signals) ? parsed.key_signals.slice(0, 8).map((item) => String(item).slice(0, 200)) : [],
  };
}

function normalizeRegime(value) {
  const regime = String(value || '').trim().toLowerCase();
  return ['trending_bull', 'trending_bear', 'ranging', 'volatile', 'unknown'].includes(regime)
    ? regime
    : 'unknown';
}

function normalizeLlmConfidence(value, fallback = 0.5) {
  const raw = toNumber(value, fallback);
  if (!Number.isFinite(raw)) return fallback;
  const ratio = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, ratio));
}

async function insertShadow(rule, llm) {
  await db.run(
    `INSERT INTO investment.luna_regime_llm_shadow
       (market, rule_regime, rule_confidence, llm_regime, llm_confidence,
        llm_rationale, llm_duration, llm_key_signals)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      rule.market,
      rule.regime,
      rule.confidence,
      llm.regime,
      llm.confidence,
      llm.rationale,
      llm.durationEstimate,
      JSON.stringify(llm.keySignals || []),
    ],
  );
}

async function analyzeMarket(market, options) {
  const rule = await latestRuleSnapshot(market);
  if (!rule) {
    return { market, status: 'skipped', reason: 'rule_snapshot_missing', llmCalled: false, written: false };
  }

  const shadow = await latestShadowSnapshot(market);
  if (shadowFreshEnough({ shadow, rule, ttlMinutes: options.ttlMinutes, force: options.force })) {
    return {
      market,
      status: 'skipped',
      reason: 'fresh_shadow_exists',
      ruleRegime: rule.regime,
      shadowRegime: shadow.llm_regime || null,
      shadowCapturedAt: shadow.captured_at || null,
      llmCalled: false,
      written: false,
    };
  }

  if (!options.apply || options.confirm !== CONFIRM_TOKEN) {
    return {
      market,
      status: 'planned',
      reason: 'apply_confirm_required',
      ruleRegime: rule.regime,
      ruleCapturedAt: rule.capturedAt,
      llmCalled: false,
      written: false,
    };
  }

  const llm = await callViaHub('luna', 'Luna Phase 1 market regime shadow analyzer', buildPrompt(rule), {
    market,
    taskType: 'regime_analysis',
    urgency: 'low',
    maxTokens: 600,
    timeoutMs: 60_000,
  });

  if (!llm.ok) {
    return {
      market,
      status: 'degraded',
      reason: 'llm_call_failed',
      error: llm.error || 'unknown',
      ruleRegime: rule.regime,
      llmCalled: true,
      written: false,
    };
  }

  let parsed;
  try {
    parsed = normalizeLlmResult(llm.text);
  } catch (error) {
    return {
      market,
      status: 'degraded',
      reason: 'llm_parse_failed',
      error: String(error?.message || error),
      ruleRegime: rule.regime,
      llmCalled: true,
      written: false,
    };
  }

  await insertShadow(rule, parsed);
  return {
    market,
    status: 'written',
    ruleRegime: rule.regime,
    llmRegime: parsed.regime,
    match: rule.regime === parsed.regime,
    llmCalled: true,
    written: true,
  };
}

export async function runLunaRegimeLlmShadow(options = parseArgs()) {
  await db.initSchema();

  if (process.env.LUNA_REGIME_LLM_SHADOW_ENABLED === 'false') {
    return {
      ok: true,
      status: 'luna_regime_llm_shadow_disabled',
      apply: options.apply,
      markets: options.markets,
      rows: [],
    };
  }

  const rows = [];
  for (const market of options.markets) {
    rows.push(await analyzeMarket(market, options));
  }

  const written = rows.filter((row) => row.written).length;
  const planned = rows.filter((row) => row.status === 'planned').length;
  const degraded = rows.filter((row) => row.status === 'degraded').length;
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  return {
    ok: true,
    status: written > 0
      ? 'luna_regime_llm_shadow_written'
      : degraded > 0
        ? 'luna_regime_llm_shadow_degraded'
        : planned > 0
          ? 'luna_regime_llm_shadow_planned'
          : 'luna_regime_llm_shadow_skipped',
    apply: options.apply,
    confirmRequired: CONFIRM_TOKEN,
    ttlMinutes: options.ttlMinutes,
    summary: {
      markets: rows.length,
      written,
      planned,
      degraded,
      skipped,
      llmCalls: rows.filter((row) => row.llmCalled).length,
    },
    rows,
  };
}

async function main() {
  const result = await runLunaRegimeLlmShadow(parseArgs());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status} written=${result.summary?.written || 0} planned=${result.summary?.planned || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna regime LLM shadow 오류:',
  });
}
