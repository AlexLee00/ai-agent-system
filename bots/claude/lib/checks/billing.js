'use strict';

/**
 * checks/billing.js — 덱스터 체크 모듈 [billing]
 *
 * 역할:
 *   1. Anthropic Admin API 호출 → 월간 실비용 수집 + DB 저장
 *   2. OpenAI Usage API 호출 → 월간 실비용 수집 + DB 저장
 *   3. 예산 초과 / 이상 급등 감지 → warn/error
 *
 * 실행 주기: 덱스터 기본 주기 (1h)
 * DB: claude.billing_snapshots (일별 upsert)
 */

const https   = require('https');
const pgPool  = require('../../../../packages/core/lib/pg-pool');
const { getAnthropicAdminKey, getOpenAIAdminKey, getBillingBudget } = require('../../../../packages/core/lib/llm-keys');

// ── 예산/임계값 ────────────────────────────────────────────────────

const getBudget        = () => getBillingBudget();
const SPIKE_THRESHOLD  = () => getBillingBudget().spike_threshold;

// ── DB 초기화 ─────────────────────────────────────────────────────

let _tableReady = false;

async function _ensureTable() {
  if (_tableReady) return;
  await pgPool.run('claude', `
    CREATE TABLE IF NOT EXISTS billing_snapshots (
      id          SERIAL PRIMARY KEY,
      provider    TEXT    NOT NULL,
      date        DATE    NOT NULL,
      cost_usd    NUMERIC(10,4) DEFAULT 0,
      token_count BIGINT  DEFAULT 0,
      details     JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (provider, date)
    )
  `);
  await pgPool.run('claude', `
    CREATE INDEX IF NOT EXISTS idx_billing_provider_date
    ON billing_snapshots(provider, date DESC)
  `);
  _tableReady = true;
}

// ── Anthropic Admin API ───────────────────────────────────────────

async function fetchAnthropicCost() {
  const adminKey = getAnthropicAdminKey();
  if (!adminKey) return null;

  const now        = new Date();
  const startingAt = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const endingAt   = now.toISOString();

  try {
    // 월간 비용 리포트 (Admin API — cost_report, 일별 granularity)
    const data = await _httpGet(
      `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(startingAt)}&ending_at=${encodeURIComponent(endingAt)}`,
      {
        'anthropic-version': '2023-06-01',
        'x-api-key': adminKey,
      }
    );
    return data;
  } catch (e) {
    return { _error: e.message };
  }
}

// ── OpenAI Usage API ──────────────────────────────────────────────

async function fetchOpenAICost() {
  const apiKey = getOpenAIAdminKey();
  if (!apiKey) return null;

  const now   = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  try {
    const data = await _httpGet(
      `https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d`,
      {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      }
    );
    return data;
  } catch (e) {
    return { _error: e.message };
  }
}

// ── DB 저장 ───────────────────────────────────────────────────────

async function saveBillingSnapshot(provider, costUsd, details) {
  try {
    await pgPool.run('claude', `
      INSERT INTO billing_snapshots (provider, date, cost_usd, details, created_at)
      VALUES ($1, CURRENT_DATE, $2, $3, NOW())
      ON CONFLICT (provider, date) DO UPDATE
        SET cost_usd = $2, details = $3, created_at = NOW()
    `, [provider, costUsd, JSON.stringify(details)]);
  } catch (e) {
    console.warn(`[덱스터/billing] DB 저장 실패: ${e.message}`);
  }
}

// ── 이상 감지 ─────────────────────────────────────────────────────

async function detectAnomalies(provider, monthlyCost) {
  const budget = getBudget();
  const limit  = budget[provider] || budget.total;
  const alerts = [];

  // 1. 예산 초과
  if (monthlyCost > limit) {
    alerts.push({ status: 'error', msg: `${provider} 월간 예산 초과! $${monthlyCost.toFixed(2)} / $${limit} (${Math.round(monthlyCost / limit * 100)}%)` });
  } else if (monthlyCost > limit * 0.8) {
    alerts.push({ status: 'warn', msg: `${provider} 월간 예산 80% 도달: $${monthlyCost.toFixed(2)} / $${limit}` });
  }

  // 2. 일일 급등 (전일 대비)
  const yesterday = await pgPool.get('claude',
    `SELECT cost_usd FROM billing_snapshots WHERE provider = $1 AND date = CURRENT_DATE - 1`,
    [provider]
  );
  if (yesterday) {
    const prev  = parseFloat(yesterday.cost_usd || 0);
    const today = await pgPool.get('claude',
      `SELECT cost_usd FROM billing_snapshots WHERE provider = $1 AND date = CURRENT_DATE`,
      [provider]
    );
    const todayCost = parseFloat(today?.cost_usd || 0);
    if (prev > 0 && todayCost / prev >= SPIKE_THRESHOLD()) {
      alerts.push({ status: 'warn', msg: `${provider} 일일 비용 급등! $${todayCost.toFixed(3)} (전일 대비 ${(todayCost / prev).toFixed(1)}배)` });
    }
  }

  return alerts;
}

// ── 비용 파싱 ─────────────────────────────────────────────────────

function parseAnthropicCost(data) {
  // cost_report 응답: { data: [{ starting_at, ending_at, results: [{ currency, amount }] }] }
  // amount: USD 센트(cent) decimal string → /100 해서 USD로 변환
  if (data?._error) return { cost: 0, error: data._error };
  const buckets = data?.data || [];
  let totalCents = 0;
  for (const bucket of buckets) {
    for (const r of (bucket.results || [])) {
      const c = parseFloat(r.amount ?? 0);
      totalCents += isNaN(c) ? 0 : c;
    }
  }
  return { cost: totalCents / 100 };  // 센트 → USD
}

function parseOpenAICost(data) {
  // 응답 형식: { data: [{ start_time, end_time, results: [{ amount: { value, currency } }] }] }
  if (data?._error) return { cost: 0, error: data._error };
  const buckets = data?.data || [];
  let total = 0;
  for (const bucket of buckets) {
    for (const result of (bucket.results || [])) {
      const cost = parseFloat(result.amount?.value || result.cost_usd || 0);
      total += isNaN(cost) ? 0 : cost;
    }
  }
  return { cost: total };
}

// ── 메인: 덱스터 체크 함수 ────────────────────────────────────────

async function run() {
  const items = [];

  try {
    await _ensureTable();
  } catch (e) {
    return {
      name:   'API 빌링',
      status: 'warn',
      items:  [{ label: 'DB 초기화', status: 'warn', detail: e.message }],
    };
  }

  const budget = getBudget();

  // ── Anthropic ──
  try {
    const raw     = await fetchAnthropicCost();
    const parsed  = parseAnthropicCost(raw);

    if (parsed.error) {
      items.push({ label: 'Anthropic 빌링 API', status: 'warn', detail: `API 오류: ${parsed.error}` });
    } else {
      await saveBillingSnapshot('anthropic', parsed.cost, raw);
      items.push({
        label:  'Anthropic 월간 비용',
        status: parsed.cost > budget.anthropic ? 'error' : parsed.cost > budget.anthropic * 0.8 ? 'warn' : 'ok',
        detail: `$${parsed.cost.toFixed(3)} / $${budget.anthropic} (${Math.round(parsed.cost / budget.anthropic * 100)}%)`,
      });
      const alerts = await detectAnomalies('anthropic', parsed.cost);
      for (const a of alerts) {
        items.push({ label: 'Anthropic 이상', status: a.status, detail: a.msg });
      }
    }
  } catch (e) {
    items.push({ label: 'Anthropic 빌링', status: 'warn', detail: `조회 실패: ${e.message}` });
  }

  // ── OpenAI ──
  try {
    const raw    = await fetchOpenAICost();
    const parsed = parseOpenAICost(raw);

    if (parsed.error) {
      items.push({ label: 'OpenAI 빌링 API', status: 'warn', detail: `API 오류: ${parsed.error}` });
    } else {
      await saveBillingSnapshot('openai', parsed.cost, raw);
      items.push({
        label:  'OpenAI 월간 비용',
        status: parsed.cost > budget.openai ? 'error' : parsed.cost > budget.openai * 0.8 ? 'warn' : 'ok',
        detail: `$${parsed.cost.toFixed(3)} / $${budget.openai} (${Math.round(parsed.cost / budget.openai * 100)}%)`,
      });
      const alerts = await detectAnomalies('openai', parsed.cost);
      for (const a of alerts) {
        items.push({ label: 'OpenAI 이상', status: a.status, detail: a.msg });
      }
    }
  } catch (e) {
    items.push({ label: 'OpenAI 빌링', status: 'warn', detail: `조회 실패: ${e.message}` });
  }

  // ── 전체 합산 ──
  try {
    const totals = await pgPool.query('claude', `
      SELECT provider, cost_usd
      FROM billing_snapshots
      WHERE date >= date_trunc('month', CURRENT_DATE)::date
        AND date <= CURRENT_DATE
        AND provider IN ('anthropic','openai')
      ORDER BY date DESC
    `);
    // provider별 최신 값 합산 (날짜별 upsert이므로 SUM이 월간 누적)
    const monthlyMap = {};
    for (const row of totals) {
      if (!monthlyMap[row.provider]) monthlyMap[row.provider] = 0;
      monthlyMap[row.provider] += parseFloat(row.cost_usd || 0);
    }
    // 실제로는 date별 1행이므로 단순 합산
    const monthlyRows = await pgPool.query('claude', `
      SELECT provider, SUM(cost_usd) AS total
      FROM billing_snapshots
      WHERE date >= date_trunc('month', CURRENT_DATE)::date
      GROUP BY provider
    `);
    let grandTotal = 0;
    for (const r of monthlyRows) grandTotal += parseFloat(r.total || 0);

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const daysPassed  = new Date().getDate();
    const burnRate    = daysPassed > 0 ? grandTotal / daysPassed : 0;
    const projected   = burnRate * daysInMonth;

    const totalStatus = grandTotal > budget.total ? 'error' : grandTotal > budget.total * 0.8 ? 'warn' : 'ok';
    items.push({
      label:  '전체 월간 합산',
      status: totalStatus,
      detail: `$${grandTotal.toFixed(3)} / $${budget.total} | 예상 월말: $${projected.toFixed(2)} (일평균 $${burnRate.toFixed(3)})`,
    });
  } catch (e) {
    items.push({ label: '합산 조회', status: 'warn', detail: e.message });
  }

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');

  return {
    name:   'API 빌링',
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

// ── HTTP 유틸 ─────────────────────────────────────────────────────

function _httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers,
      timeout:  30000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON 파싱 실패 (HTTP ${res.statusCode}): ${body.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('타임아웃 (30s)')); });
  });
}

module.exports = { run };
