// @ts-nocheck
/**
 * shared/hub-llm-client.ts — Hub /hub/llm/call HTTP 클라이언트 (Phase LUNA_REMODEL Phase 1)
 *
 * Kill Switch:
 *   INVESTMENT_LLM_HUB_ENABLED=false → 긴급 시 Hub 우회
 *   INVESTMENT_LLM_HUB_SHADOW=true   → Shadow Mode (Hub 호출 후 결과 비교, 실제 응답은 직접 호출)
 *
 * 반환: { ok, text, provider, costUsd, latencyMs, error? }
 */

import { createRequire } from 'module';
import { resolveHubRoutingPlan } from './agent-llm-routing.ts';
import {
  buildRouteHealthAvoidance,
  reorderChainForRouteHealth,
} from './agent-llm-route-health.ts';
import { injectMemoryIntoSystemPrompt } from './agent-memory-orchestrator.ts';
import { recordLLMFailure, getAvoidProviders } from './reflexion-guard.ts';
import { recordInvocation } from './agent-curriculum-tracker.ts';
import * as db from './db.ts';

const _require = createRequire(import.meta.url);
const _hubClient = _require('../../../packages/core/lib/hub-client');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TIMEOUT_MS = 65_000;

export function isHubEnabled(): boolean {
  return process.env.INVESTMENT_LLM_HUB_ENABLED !== 'false';
}

export function isHubShadow(): boolean {
  return process.env.INVESTMENT_LLM_HUB_SHADOW === 'true';
}

type HubUrgency = 'low' | 'normal' | 'high' | 'critical';

export function normalizeHubUrgency(value: unknown): HubUrgency {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'critical') return 'critical';
  if (text === 'high') return 'high';
  if (text === 'low') return 'low';
  // Hub schema uses "normal"; legacy Luna callers used "medium".
  return 'normal';
}

export function getHubCallerTeam(): string {
  return String(process.env.INVESTMENT_LLM_HUB_TEAM || 'luna').trim() || 'luna';
}

export function isDirectFallbackEnabled(): boolean {
  return process.env.INVESTMENT_LLM_DIRECT_FALLBACK === 'true';
}

export interface HubLLMResult {
  ok: boolean;
  text: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export async function recordInvestmentLlmRouteLog(entry: {
  agentName: string;
  provider?: string;
  ok?: boolean;
  costUsd?: number;
  latencyMs?: number;
  market?: string | null;
  symbol?: string | null;
  taskType?: string | null;
  incidentKey?: string | null;
  shadowMode?: boolean;
  fallbackUsed?: boolean;
  fallbackCount?: number;
  error?: string | null;
  routeChain?: unknown[];
  hubText?: string | null;
  directText?: string | null;
  matched?: boolean | null;
}): Promise<void> {
  try {
    await db.run(
      `INSERT INTO investment.llm_routing_log
         (agent_name, provider, response_ok, cost_usd, latency_ms, market, symbol, task_type,
          incident_key, shadow_mode, fallback_used, fallback_count, error, route_chain,
          hub_text, direct_text, matched, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,NOW())`,
      [
        entry.agentName,
        entry.provider || null,
        entry.ok == null ? null : entry.ok === true,
        Number(entry.costUsd || 0),
        Math.max(0, Math.round(Number(entry.latencyMs || 0))),
        entry.market || null,
        entry.symbol || null,
        entry.taskType || null,
        entry.incidentKey || null,
        entry.shadowMode === true,
        entry.fallbackUsed === true,
        Math.max(0, Math.round(Number(entry.fallbackCount || 0))),
        entry.error ? String(entry.error).slice(0, 500) : null,
        JSON.stringify(Array.isArray(entry.routeChain) ? entry.routeChain.slice(0, 8) : []),
        entry.hubText ? String(entry.hubText).slice(0, 2000) : null,
        entry.directText ? String(entry.directText).slice(0, 2000) : null,
        entry.matched == null ? null : entry.matched === true,
      ],
    );
  } catch {
    // 라우팅 로그는 관측 채널이므로 실패해도 LLM 호출 흐름은 막지 않는다.
  }
}

export function buildHubLlmCallPayload(
  agentName: string,
  systemPrompt: string,
  userPrompt: string,
  options: {
    maxTokens?: number;
    symbol?: string;
    market?: string;
    urgency?: 'critical' | 'high' | 'normal' | 'medium' | 'low';
    callerTeam?: string;
    taskType?: string;
    incidentKey?: string;
    avoidProviders?: string[];
    chainAvoidProviders?: string[];
  } = {}
) {
  // Phase C: 에이전트×시장×태스크 동적 라우팅 (chain 우선, abstractModel은 호환 유지)
  const routingPlan = resolveHubRoutingPlan(
    agentName,
    options.market || 'any',
    options.taskType || 'default',
    options.maxTokens,
  );
  const abstractModel = normalizeHubAbstractModel(routingPlan.abstractModel);
  const routeHealthAvoidProviders = Array.isArray(options.chainAvoidProviders)
    ? options.chainAvoidProviders
    : Array.isArray(options.avoidProviders)
      ? options.avoidProviders
    : [];
  const chain = routeHealthAvoidProviders.length > 0
    ? reorderChainForRouteHealth(routingPlan.chain, routeHealthAvoidProviders)
    : routingPlan.chain;
  const urgency = normalizeHubUrgency(options.urgency ?? (agentName === 'luna' ? 'high' : 'normal'));
  const payload: Record<string, unknown> = {
    prompt:        userPrompt,
    systemPrompt,
    abstractModel,
    timeoutMs:     HUB_TIMEOUT_MS - 5_000,
    agent:         agentName,
    callerTeam:    options.callerTeam || getHubCallerTeam(),
    urgency,
    taskType:      options.taskType || 'trade_signal',
    selectorKey:   'investment.agent_policy',
    market:        options.market || null,
    symbol:        options.symbol || null,
    maxTokens:     options.maxTokens,
    incidentKey:   options.incidentKey || null,
  };
  if (Array.isArray(chain) && chain.length > 0) {
    payload.chain = chain;
  }
  return payload;
}

function normalizeHubAbstractModel(value: string): 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus' {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'anthropic_haiku' || raw === 'anthropic_sonnet' || raw === 'anthropic_opus') {
    return raw;
  }
  if (raw.includes('opus')) return 'anthropic_opus';
  if (raw.includes('sonnet')) return 'anthropic_sonnet';
  return 'anthropic_haiku';
}

/**
 * Hub /hub/llm/call 호출.
 * Shadow Mode일 경우 결과를 로깅만 하고 ok:false 반환 (호출자가 직접 폴백 사용).
 */
export async function callViaHub(
  agentName: string,
  systemPrompt: string,
  userPrompt: string,
  options: {
    maxTokens?: number;
    symbol?: string;
    market?: string;
    urgency?: 'critical' | 'high' | 'normal' | 'medium' | 'low';
    taskType?: string;
    incidentKey?: string;
    shadowCompare?: string;  // Shadow Mode일 때 직접 호출 결과 (비교용)
    avoidProviders?: string[]; // Phase G: Reflexion 회피 provider 목록
  } = {}
): Promise<HubLLMResult> {
  const t0 = Date.now();
  let payload: Record<string, unknown> | null = null;

  let hubToken: string;
  try {
    const secrets = await _hubClient.fetchHubSecrets('config');
    hubToken = secrets?.hub_auth_token || process.env.HUB_AUTH_TOKEN || '';
  } catch {
    hubToken = process.env.HUB_AUTH_TOKEN || '';
  }

  if (!hubToken) {
    recordInvestmentLlmRouteLog({
      agentName,
      provider: 'hub',
      ok: false,
      latencyMs: 0,
      market: options.market || process.env.INVESTMENT_MARKET || null,
      symbol: options.symbol || null,
      taskType: options.taskType || null,
      incidentKey: options.incidentKey || null,
      error: 'missing_hub_auth_token',
    }).catch(() => {});
    return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs: 0, error: 'HUB_AUTH_TOKEN 없음' };
  }

  // Phase G: Reflexion 회피 provider 목록 (비동기 조회, 실패 시 무시)
  let hardAvoidProviders: string[] = options.avoidProviders || [];
  if (hardAvoidProviders.length === 0) {
    hardAvoidProviders = await getAvoidProviders(agentName).catch(() => []);
  }
  const routeHealth = await buildRouteHealthAvoidance({
    agentName,
    market: options.market || process.env.INVESTMENT_MARKET || 'all',
    taskType: options.taskType || 'default',
  }).catch(() => ({ enabled: false, avoidProviders: [] }));
  const chainAvoidProviders = routeHealth?.enabled && Array.isArray(routeHealth.avoidProviders)
    ? Array.from(new Set([...hardAvoidProviders, ...routeHealth.avoidProviders]))
    : hardAvoidProviders;

  payload = buildHubLlmCallPayload(agentName, systemPrompt, userPrompt, {
    maxTokens: options.maxTokens,
    symbol: options.symbol,
    market: options.market || process.env.INVESTMENT_MARKET || undefined,
    urgency: options.urgency,
    taskType: options.taskType,
    incidentKey: options.incidentKey,
    avoidProviders: hardAvoidProviders,
    chainAvoidProviders,
  });

  // Hard avoid는 Reflexion/명시 옵션만 Hub에 전달하고, route-health는 chain reorder로만 적용한다.
  if (hardAvoidProviders.length > 0) {
    (payload as any).avoidProviders = hardAvoidProviders;
  }

  const body = JSON.stringify(payload);

  try {
    const res = await fetch(`${HUB_BASE}/hub/llm/call`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${hubToken}`,
      },
      body,
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });

    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[hub-llm] ${agentName} HTTP ${res.status}: ${errText.slice(0, 120)}`);
      // Phase G: HTTP 실패 기록
      recordLLMFailure(agentName, 'hub', userPrompt, 'bad_response', options.market, options.taskType).catch(() => {});
      recordInvestmentLlmRouteLog({
        agentName,
        provider: 'hub',
        ok: false,
        latencyMs,
        market: options.market || null,
        symbol: options.symbol || null,
        taskType: options.taskType || null,
        incidentKey: options.incidentKey || null,
        error: `HTTP ${res.status}`,
        routeChain: (payload?.chain as unknown[]) || [],
      }).catch(() => {});
      return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    if (!json.ok) {
      console.warn(`[hub-llm] ${agentName} 응답 ok:false — ${json.error || '알 수 없음'}`);
      // Phase G: LLM 호출 실패 기록
      const errorType = (json.error || '').includes('timeout') ? 'timeout'
        : (json.error || '').includes('rate') ? 'rate_limit'
        : 'bad_response';
      recordLLMFailure(agentName, json.provider || 'hub', userPrompt, errorType, options.market, options.taskType).catch(() => {});
      recordInvestmentLlmRouteLog({
        agentName,
        provider: json.provider || 'hub',
        ok: false,
        latencyMs,
        market: options.market || null,
        symbol: options.symbol || null,
        taskType: options.taskType || null,
        incidentKey: options.incidentKey || null,
        fallbackCount: json.fallbackCount || 0,
        error: json.error || 'hub_response_not_ok',
        routeChain: (payload?.chain as unknown[]) || [],
      }).catch(() => {});
      return { ok: false, text: '', provider: json.provider || 'hub', costUsd: 0, latencyMs, error: json.error };
    }

    const text: string = json.result || '';
    const costUsd: number = json.totalCostUsd ?? 0;

    // Shadow Mode: 비교 로그 후 ok:false 반환 (실제 응답은 직접 호출 사용)
    if (isHubShadow() && options.shadowCompare !== undefined) {
      _logShadowComparison(agentName, text, options.shadowCompare, {
        provider: json.provider,
        costUsd,
        latencyMs,
        market: options.market,
        symbol: options.symbol,
        taskType: options.taskType,
        incidentKey: options.incidentKey,
        routeChain: (payload?.chain as unknown[]) || [],
      });
      return { ok: false, text, provider: json.provider || 'hub', costUsd, latencyMs };
    }

    console.log(`[hub-llm] ${agentName} ✓ provider=${json.provider} latency=${latencyMs}ms cost=$${costUsd.toFixed(5)}`);
    recordInvestmentLlmRouteLog({
      agentName,
      provider: json.provider || 'hub',
      ok: true,
      costUsd,
      latencyMs,
      market: options.market || null,
      symbol: options.symbol || null,
      taskType: options.taskType || null,
      incidentKey: options.incidentKey || null,
      fallbackCount: json.fallbackCount || 0,
      routeChain: (payload?.chain as unknown[]) || [],
    }).catch(() => {});
    return { ok: true, text, provider: json.provider || 'hub', costUsd, latencyMs };

  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hub-llm] ${agentName} 오류: ${msg}`);
    recordInvestmentLlmRouteLog({
      agentName,
      provider: 'hub',
      ok: false,
      latencyMs,
      market: options.market || null,
      symbol: options.symbol || null,
      taskType: options.taskType || null,
      incidentKey: options.incidentKey || null,
      error: msg,
      routeChain: (payload?.chain as unknown[]) || [],
    }).catch(() => {});
    return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs, error: msg };
  }
}

// ─── Shadow 비교 로깅 ─────────────────────────────────────────────────

function _logShadowComparison(
  agentName: string,
  hubText: string,
  directText: string,
  meta: {
    provider: string;
    costUsd: number;
    latencyMs: number;
    market?: string;
    symbol?: string;
    taskType?: string;
    incidentKey?: string;
    routeChain?: unknown[];
  }
) {
  try {
    const hubSignal  = _extractSignal(hubText);
    const dirSignal  = _extractSignal(directText);
    const matched    = hubSignal === dirSignal;
    console.log(
      `[hub-llm/shadow] ${agentName} hub=${hubSignal} direct=${dirSignal} ` +
      `matched=${matched} provider=${meta.provider} latency=${meta.latencyMs}ms cost=$${meta.costUsd.toFixed(5)}`
    );

    // DB에 shadow 비교 결과 저장 (비동기, 실패해도 무시)
    _saveShadowLog(agentName, hubText, directText, matched, meta).catch(() => {});
  } catch {
    // 비교 실패는 무시
  }
}

function _extractSignal(text: string): string {
  if (!text) return 'UNKNOWN';
  try {
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = clean.search(/[\[{]/);
    const end   = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
    if (start === -1 || end === -1) return 'PARSE_FAIL';
    const json = JSON.parse(clean.slice(start, end + 1));
    return json.signal || json.action || json.recommendation || 'NO_SIGNAL';
  } catch {
    return 'PARSE_FAIL';
  }
}

async function _saveShadowLog(
  agentName: string,
  hubText: string,
  directText: string,
  matched: boolean,
  meta: {
    provider: string;
    costUsd: number;
    latencyMs: number;
    market?: string;
    symbol?: string;
    taskType?: string;
    incidentKey?: string;
    routeChain?: unknown[];
  }
) {
  await recordInvestmentLlmRouteLog({
    agentName,
    provider: meta.provider,
    ok: true,
    costUsd: meta.costUsd,
    latencyMs: meta.latencyMs,
    market: meta.market || null,
    symbol: meta.symbol || null,
    taskType: meta.taskType || null,
    incidentKey: meta.incidentKey || null,
    shadowMode: true,
    routeChain: meta.routeChain || [],
    hubText,
    directText,
    matched,
  });
}

// ─── 편의 래퍼: 에이전트 파일에서 callLLM 대체용 ──────────────────────────
// 사용 패턴:
//   const text = await callLLMWithHub('luna', systemPrompt, userMsg, callLLM, 768, { symbol });

export async function callLLMWithHub(
  agentName: string,
  systemPrompt: string,
  userMsg: string,
  directFn: (agent: string, system: string, user: string, maxTokens: number, opts?: unknown) => Promise<string>,
  maxTokens?: number,
  opts: {
    symbol?: string;
    market?: string;
    cacheTTL?: number;
    taskType?: string;
    purpose?: string;
    incidentKey?: string;
    workingState?: string;
  } = {}
): Promise<string> {
  const shadow = isHubShadow();
  const enabled = isHubEnabled();
  const directFallbackEnabled = isDirectFallbackEnabled();

  // Phase B: 8종 메모리 prefix 자동 주입
  let enrichedSystemPrompt = systemPrompt;
  try {
    enrichedSystemPrompt = await injectMemoryIntoSystemPrompt(systemPrompt, {
      agentName,
      market: opts.market,
      symbol: opts.symbol,
      taskType: opts.taskType,
      incidentKey: opts.incidentKey,
      workingState: opts.workingState,
    });
  } catch {
    // 메모리 주입 실패는 원본 프롬프트로 폴백 (운영 중단 없음)
  }

  if (!enabled && !shadow) {
    if (!directFallbackEnabled) {
      throw new Error('Investment LLM Hub routing is disabled; 직접 LLM 경로는 INVESTMENT_LLM_DIRECT_FALLBACK=true일 때만 허용');
    }
    const directResult = await directFn(agentName, enrichedSystemPrompt, userMsg, maxTokens ?? 512, opts);
    recordInvestmentLlmRouteLog({
      agentName,
      provider: 'direct_fallback',
      ok: true,
      market: opts.market || null,
      symbol: opts.symbol || null,
      taskType: opts.taskType || opts.purpose || 'default',
      incidentKey: opts.incidentKey || null,
      fallbackUsed: true,
      error: 'hub_disabled',
    }).catch(() => {});
    recordInvocation(agentName, opts.market ?? 'any').catch(() => {});
    return directResult;
  }

  if (shadow) {
    // Shadow: Hub 호출(비동기, 로깅용) + 직접 호출(실제 결과)
    const directResult = await directFn(agentName, enrichedSystemPrompt, userMsg, maxTokens ?? 512, opts);
    callViaHub(agentName, enrichedSystemPrompt, userMsg, {
      maxTokens,
      symbol: opts.symbol,
      market: opts.market,
      taskType: opts.taskType || opts.purpose || 'default',
      incidentKey: opts.incidentKey,
      shadowCompare: directResult,
    }).catch(() => {});
    // Phase D: invocation 기록 (fire-and-forget)
    recordInvocation(agentName, opts.market ?? 'any').catch(() => {});
    return directResult;
  }

  // Hub 활성: Hub 우선, 실패 시 직접 호출 폴백
  const hubResult = await callViaHub(agentName, enrichedSystemPrompt, userMsg, {
    maxTokens,
    symbol: opts.symbol,
    market: opts.market,
    taskType: opts.taskType || opts.purpose || 'default',
    incidentKey: opts.incidentKey,
  });
  if (hubResult.ok) {
    // Phase D: invocation 기록 (fire-and-forget)
    recordInvocation(agentName, opts.market ?? 'any').catch(() => {});
    return hubResult.text;
  }

  if (!directFallbackEnabled) {
    throw new Error(`Hub LLM 호출 실패: ${hubResult.error || 'unknown'} — 직접 LLM 폴백은 INVESTMENT_LLM_DIRECT_FALLBACK=true일 때만 허용`);
  }

  console.warn(`[hub-llm] ${agentName} Hub 실패(${hubResult.error}), 명시적 직접 호출 폴백`);
  const fallbackResult = await directFn(agentName, enrichedSystemPrompt, userMsg, maxTokens ?? 512, opts);
  recordInvestmentLlmRouteLog({
    agentName,
    provider: 'direct_fallback',
    ok: true,
    market: opts.market || null,
    symbol: opts.symbol || null,
    taskType: opts.taskType || opts.purpose || 'default',
    incidentKey: opts.incidentKey || null,
    fallbackUsed: true,
    fallbackCount: 1,
    error: hubResult.error || 'hub_failed',
  }).catch(() => {});
  // Phase D: fallback 경로도 invocation 기록
  recordInvocation(agentName, opts.market ?? 'any').catch(() => {});
  return fallbackResult;
}
