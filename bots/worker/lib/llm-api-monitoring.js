'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));
const {
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getGroqAccounts,
} = require(path.join(__dirname, '../../../packages/core/lib/llm-keys'));
const { describeLLMSelector } = require(path.join(__dirname, '../../../packages/core/lib/llm-model-selector'));
const {
  buildSpeedLookup,
  buildSelectorAdvice,
} = require(path.join(__dirname, '../../../packages/core/lib/llm-selector-advisor'));
const { getWorkerLLMSelectorOverrides } = require('./runtime-config');

const SCHEMA = 'worker';
const PREFERENCE_KEY = 'worker_monitoring_llm_api';
const ALLOWED_APIS = ['groq', 'anthropic', 'openai', 'gemini'];
const SPEED_TEST_LATEST_FILE = path.join(process.env.HOME || '', '.openclaw/workspace/llm-speed-test-latest.json');

const API_CATALOG = {
  groq: {
    key: 'groq',
    label: 'Groq',
    primaryModel: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    description: '빠른 응답이 필요한 워커 웹 분석에 적합한 무료 우선 경로입니다.',
  },
  anthropic: {
    key: 'anthropic',
    label: 'Anthropic',
    primaryModel: 'claude-haiku-4-5-20251001',
    description: '짧은 분석과 요약에서 안정적인 추론 품질을 우선합니다.',
  },
  openai: {
    key: 'openai',
    label: 'OpenAI',
    primaryModel: 'gpt-4o-mini',
    description: '일반적인 운영 분석과 구조화 응답에 무난한 호환성을 기대할 수 있습니다.',
  },
  gemini: {
    key: 'gemini',
    label: 'Gemini',
    primaryModel: 'gemini-2.5-flash',
    description: '문서/분류 계열 흐름과 맞닿아 있는 저비용 멀티모달 계열입니다.',
  },
};

let ensured = false;

async function ensureSystemPreferencesTable() {
  if (ensured) return;
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS worker.system_preferences (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER REFERENCES worker.users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS worker.system_preference_events (
      id BIGSERIAL PRIMARY KEY,
      preference_key TEXT NOT NULL,
      previous_value JSONB,
      next_value JSONB NOT NULL DEFAULT '{}'::jsonb,
      change_note TEXT,
      changed_by INTEGER REFERENCES worker.users(id),
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pgPool.run(SCHEMA, `
    ALTER TABLE worker.system_preference_events
    ADD COLUMN IF NOT EXISTS change_note TEXT
  `);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_worker_system_preference_events_key_changed_at
    ON worker.system_preference_events (preference_key, changed_at DESC)
  `);
  ensured = true;
}

function isProviderConfigured(provider) {
  if (provider === 'groq') return Array.isArray(getGroqAccounts()) && getGroqAccounts().length > 0;
  if (provider === 'anthropic') return Boolean(getAnthropicKey());
  if (provider === 'openai') return Boolean(getOpenAIKey());
  if (provider === 'gemini') return Boolean(getGeminiKey());
  return false;
}

function buildProviderOptions() {
  return ALLOWED_APIS.map((provider) => ({
    key: provider,
    label: API_CATALOG[provider].label,
    primaryModel: API_CATALOG[provider].primaryModel,
    description: API_CATALOG[provider].description,
    configured: isProviderConfigured(provider),
  }));
}

function normalizeApi(value) {
  const key = String(value || '').trim().toLowerCase();
  return ALLOWED_APIS.includes(key) ? key : 'groq';
}

function loadLatestSpeedSnapshot() {
  try {
    const fs = require('fs');
    if (!fs.existsSync(SPEED_TEST_LATEST_FILE)) return null;
    return JSON.parse(fs.readFileSync(SPEED_TEST_LATEST_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function getWorkerMonitoringPreference() {
  await ensureSystemPreferencesTable();
  const row = await pgPool.get(SCHEMA, `
    SELECT value
    FROM worker.system_preferences
    WHERE key = $1
  `, [PREFERENCE_KEY]);
  return normalizeApi(row?.value?.selected_api);
}

async function setWorkerMonitoringPreference(selectedApi, updatedBy = null, changeNote = null) {
  await ensureSystemPreferencesTable();
  const api = normalizeApi(selectedApi);
  const normalizedNote = String(changeNote || '').trim().slice(0, 300) || null;
  const current = await pgPool.get(SCHEMA, `
    SELECT value
    FROM worker.system_preferences
    WHERE key = $1
  `, [PREFERENCE_KEY]);
  const previousValue = current?.value || {};
  const previousApi = normalizeApi(previousValue?.selected_api);

  await pgPool.run(SCHEMA, `
    INSERT INTO worker.system_preferences (key, value, updated_by, updated_at)
    VALUES ($1, $2::jsonb, $3, NOW())
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
  `, [PREFERENCE_KEY, JSON.stringify({ selected_api: api }), updatedBy]);

  if (previousApi !== api) {
    await pgPool.run(SCHEMA, `
      INSERT INTO worker.system_preference_events
        (preference_key, previous_value, next_value, change_note, changed_by, changed_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, NOW())
    `, [
      PREFERENCE_KEY,
      JSON.stringify(previousValue),
      JSON.stringify({ selected_api: api }),
      normalizedNote,
      updatedBy,
    ]);
  }

  return api;
}

async function getWorkerMonitoringChangeHistory(limit = 10) {
  await ensureSystemPreferencesTable();
  return pgPool.query(SCHEMA, `
    SELECT
      e.id,
      e.preference_key,
      e.previous_value,
      e.next_value,
      e.change_note,
      e.changed_at,
      u.id AS changed_by_id,
      COALESCE(NULLIF(u.name, ''), u.username, '알 수 없음') AS changed_by_name,
      u.role AS changed_by_role
    FROM worker.system_preference_events e
    LEFT JOIN worker.users u ON u.id = e.changed_by
    WHERE e.preference_key = $1
    ORDER BY e.changed_at DESC
    LIMIT $2
  `, [PREFERENCE_KEY, limit]);
}

function toIsoString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildChangeImpactSummary({ event, beforeRows, afterRows, windowHours = 12 }) {
  const before = summarizeUsageRows(beforeRows);
  const after = summarizeUsageRows(afterRows);
  const successRateDeltaPct = Number((after.successRatePct - before.successRatePct).toFixed(1));
  const avgLatencyDeltaMs = before.avgLatencyMs !== null && after.avgLatencyMs !== null
    ? after.avgLatencyMs - before.avgLatencyMs
    : null;

  return {
    id: event.id,
    changedAt: event.changed_at,
    windowHours,
    previousApi: normalizeApi(event.previous_value?.selected_api),
    nextApi: normalizeApi(event.next_value?.selected_api),
    changeNote: event.change_note || '',
    before,
    after,
    successRateDeltaPct,
    avgLatencyDeltaMs,
    enoughData: before.totalCalls >= 3 && after.totalCalls >= 3,
  };
}

function providerFromModel(model = '') {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  if (model.startsWith('gemini-') || model.startsWith('google-gemini-cli/')) return 'gemini';
  if (model.startsWith('groq/') || model.startsWith('meta-llama/') || model.startsWith('llama-') || model.startsWith('qwen/')) return 'groq';
  return 'unknown';
}

function summarizeUsageRows(rows = []) {
  const summary = {
    periodHours: 24,
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    successRatePct: 0,
    totalCostUsd: 0,
    avgLatencyMs: null,
    latestCallAt: null,
    byProvider: [],
    byRoute: [],
  };

  const providerMap = new Map();
  const routeMap = new Map();
  let latencyCount = 0;
  let latencyTotalMs = 0;

  for (const row of rows) {
    const provider = providerFromModel(String(row.model || ''));
    const route = row.request_type === 'revenue_forecast' ? '/api/ai/revenue-forecast' : '/api/ai/ask';
    const success = Number(row.success) === 1;
    const cost = Number(row.cost_usd || 0);
    const latencyMs = Number(row.latency_ms);
    const hasLatency = Number.isFinite(latencyMs) && latencyMs >= 0;

    summary.totalCalls += 1;
    if (success) summary.successCalls += 1;
    else summary.failedCalls += 1;
    summary.totalCostUsd += cost;
    if (hasLatency) {
      latencyCount += 1;
      latencyTotalMs += latencyMs;
    }
    if (!summary.latestCallAt || new Date(row.created_at) > new Date(summary.latestCallAt)) {
      summary.latestCallAt = row.created_at;
    }

    if (!providerMap.has(provider)) {
      providerMap.set(provider, {
        provider,
        label: API_CATALOG[provider]?.label || provider,
        calls: 0,
        successCalls: 0,
        failedCalls: 0,
        totalCostUsd: 0,
        latestModel: null,
        latencyCount: 0,
        latencyTotalMs: 0,
      });
    }
    const providerItem = providerMap.get(provider);
    providerItem.calls += 1;
    if (success) providerItem.successCalls += 1;
    else providerItem.failedCalls += 1;
    providerItem.totalCostUsd += cost;
    providerItem.latestModel = row.model || providerItem.latestModel;
    if (hasLatency) {
      providerItem.latencyCount += 1;
      providerItem.latencyTotalMs += latencyMs;
    }

    if (!routeMap.has(route)) {
      routeMap.set(route, {
        route,
        calls: 0,
        successCalls: 0,
        failedCalls: 0,
        latestCallAt: null,
        latencyCount: 0,
        latencyTotalMs: 0,
      });
    }
    const routeItem = routeMap.get(route);
    routeItem.calls += 1;
    if (success) routeItem.successCalls += 1;
    else routeItem.failedCalls += 1;
    if (hasLatency) {
      routeItem.latencyCount += 1;
      routeItem.latencyTotalMs += latencyMs;
    }
    if (!routeItem.latestCallAt || new Date(row.created_at) > new Date(routeItem.latestCallAt)) {
      routeItem.latestCallAt = row.created_at;
    }
  }

  summary.successRatePct = summary.totalCalls
    ? Number(((summary.successCalls / summary.totalCalls) * 100).toFixed(1))
    : 0;
  summary.totalCostUsd = Number(summary.totalCostUsd.toFixed(4));
  summary.avgLatencyMs = latencyCount ? Math.round(latencyTotalMs / latencyCount) : null;
  summary.byProvider = Array.from(providerMap.values())
    .map((item) => ({
      ...item,
      totalCostUsd: Number(item.totalCostUsd.toFixed(4)),
      successRatePct: item.calls ? Number(((item.successCalls / item.calls) * 100).toFixed(1)) : 0,
      avgLatencyMs: item.latencyCount ? Math.round(item.latencyTotalMs / item.latencyCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls);
  summary.byRoute = Array.from(routeMap.values())
    .map((item) => ({
      ...item,
      successRatePct: item.calls ? Number(((item.successCalls / item.calls) * 100).toFixed(1)) : 0,
      avgLatencyMs: item.latencyCount ? Math.round(item.latencyTotalMs / item.latencyCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls);
  return summary;
}

async function getWorkerMonitoringUsageSummary() {
  const rows = await pgPool.query('reservation', `
    SELECT model, request_type, success, cost_usd, latency_ms, created_at
    FROM llm_usage_log
    WHERE team = 'worker'
      AND bot = 'ai-client'
      AND request_type IN ('ai_question', 'revenue_forecast')
      AND created_at::timestamptz > NOW() - INTERVAL '24 hours'
    ORDER BY created_at DESC
    LIMIT 500
  `);
  return summarizeUsageRows(rows);
}

async function getWorkerMonitoringChangeImpact(limit = 3, windowHours = 12) {
  await ensureSystemPreferencesTable();
  const events = await getWorkerMonitoringChangeHistory(limit);
  if (!events.length) return [];

  const oldestEvent = events[events.length - 1];
  const oldestIso = toIsoString(new Date(new Date(oldestEvent.changed_at).getTime() - (windowHours * 60 * 60 * 1000)));
  const newestIso = toIsoString(new Date(new Date(events[0].changed_at).getTime() + (windowHours * 60 * 60 * 1000)));
  if (!oldestIso || !newestIso) return [];

  const rows = await pgPool.query('reservation', `
    SELECT model, request_type, success, cost_usd, latency_ms, created_at
    FROM llm_usage_log
    WHERE team = 'worker'
      AND bot = 'ai-client'
      AND request_type IN ('ai_question', 'revenue_forecast')
      AND created_at::timestamptz >= $1::timestamptz
      AND created_at::timestamptz < $2::timestamptz
    ORDER BY created_at DESC
    LIMIT 2000
  `, [oldestIso, newestIso]);

  return events.map((event) => {
    const changedAt = new Date(event.changed_at);
    const beforeStart = new Date(changedAt.getTime() - (windowHours * 60 * 60 * 1000));
    const afterEnd = new Date(changedAt.getTime() + (windowHours * 60 * 60 * 1000));
    const beforeRows = rows.filter((row) => {
      const createdAt = new Date(row.created_at);
      return createdAt >= beforeStart && createdAt < changedAt;
    });
    const afterRows = rows.filter((row) => {
      const createdAt = new Date(row.created_at);
      return createdAt >= changedAt && createdAt < afterEnd;
    });
    return buildChangeImpactSummary({ event, beforeRows, afterRows, windowHours });
  });
}

function getWorkerLlmApplicationSummary(selectedApi) {
  const selected = normalizeApi(selectedApi);
  const selectedInfo = API_CATALOG[selected];

  return [
    {
      area: '관리자 AI 질문',
      route: '/api/ai/ask',
      currentApi: selectedInfo.label,
      currentModel: selectedInfo.primaryModel,
      description: '관리자용 SQL 생성과 결과 요약은 워커 모니터링에서 선택한 API를 우선 사용합니다.',
    },
    {
      area: '매출 예측 보조 분석',
      route: '/api/ai/revenue-forecast',
      currentApi: selectedInfo.label,
      currentModel: selectedInfo.primaryModel,
      description: '워커 웹 매출 예측의 서술형 분석과 요약 경로도 같은 기본 API 선택을 따릅니다.',
    },
    {
      area: '대화형 업무 인텐트 파싱',
      route: 'worker-chat',
      currentApi: 'Groq → Anthropic',
      currentModel: 'llama-4-scout-17b-16e-instruct → claude-haiku-4-5-20251001',
      description: '채팅 명령 파서는 고정 폴백 체인을 유지합니다. 이번 선택값으로 바꾸지 않습니다.',
    },
    {
      area: '문서 업로드 자동 분류',
      route: 'emily.uploadDocument',
      currentApi: 'Gemini Flash 우선',
      currentModel: 'geminiClient → 규칙 기반 분류 fallback',
      description: '문서 분류는 Gemini 사용 가능 시 우선 적용하고, 실패하면 규칙 분류로 안전하게 떨어집니다.',
    },
  ];
}

function buildSelectorChainSummary(description) {
  if (!description) return [];
  if (description.kind === 'chain') {
    return (description.chain || []).map((entry, index) => ({
      role: index === 0 ? 'primary' : `fallback${index}`,
      provider: entry.provider,
      model: entry.model,
      maxTokens: entry.maxTokens || null,
      temperature: entry.temperature ?? null,
    }));
  }

  const policy = description.policy || {};
  const chain = [];
  if (policy.primary) {
    chain.push({
      role: 'primary',
      provider: policy.primary.provider,
      model: policy.primary.model,
      maxTokens: policy.primary.maxTokens || null,
      temperature: policy.primary.temperature ?? null,
    });
  }
  for (const [index, entry] of (policy.fallbacks || []).entries()) {
    chain.push({
      role: `fallback${index + 1}`,
      provider: entry.provider,
      model: entry.model,
      maxTokens: entry.maxTokens || null,
      temperature: entry.temperature ?? null,
    });
  }
  return chain;
}

function getWorkerSelectorSummary(selectedApi) {
  const normalizedApi = normalizeApi(selectedApi);
  const overrides = getWorkerLLMSelectorOverrides();
  const speedSnapshot = loadLatestSpeedSnapshot();
  const speedLookup = buildSpeedLookup(speedSnapshot);
  const selectorEntries = [
    {
      key: 'worker.ai.fallback',
      label: '관리자 AI 질문 / 매출 예측 보조 분석',
      route: '/api/ai/ask, /api/ai/revenue-forecast',
      description: 'DB 선호 provider와 runtime_config override를 함께 반영한 워커 기본 분석 체인입니다.',
      detail: describeLLMSelector('worker.ai.fallback', {
        preferredApi: normalizedApi,
        configuredProviders: ['groq', 'anthropic', 'gemini', 'openai'],
        policyOverride: overrides['worker.ai.fallback'],
      }),
    },
    {
      key: 'worker.chat.task_intake',
      label: '대화형 업무 인텐트 파싱',
      route: 'worker-chat',
      description: '대화형 업무 등록과 태스크 인테이크에서 사용하는 고정 fallback 체인입니다.',
      detail: describeLLMSelector('worker.chat.task_intake', {
        policyOverride: overrides['worker.chat.task_intake'],
      }),
    },
  ];

  return selectorEntries.map((item) => ({
    key: item.key,
    label: item.label,
    route: item.route,
    description: item.description,
    chain: buildSelectorChainSummary(item.detail),
    advice: buildSelectorAdvice(item.detail, speedLookup),
  }));
}

module.exports = {
  ALLOWED_APIS,
  API_CATALOG,
  buildProviderOptions,
  ensureSystemPreferencesTable,
  getWorkerMonitoringChangeHistory,
  getWorkerMonitoringChangeImpact,
  getWorkerMonitoringPreference,
  getWorkerLlmApplicationSummary,
  getWorkerSelectorSummary,
  getWorkerMonitoringUsageSummary,
  isProviderConfigured,
  normalizeApi,
  setWorkerMonitoringPreference,
};
