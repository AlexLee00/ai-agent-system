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

// agentName → abstract model 매핑 (Hub LLM Routing 기준)
const AGENT_ABSTRACT_MODEL: Record<string, string> = {
  luna:        'anthropic_sonnet',  // 최종 판단 — sonnet급 품질
  nemesis:     'anthropic_haiku',   // 리스크 평가 — 빠른 응답
  oracle:      'anthropic_haiku',   // 온체인 분석
  hermes:      'anthropic_haiku',   // 뉴스 분석
  sophia:      'anthropic_haiku',   // 감성 분석
  zeus:        'anthropic_haiku',   // 상향 논거
  athena:      'anthropic_haiku',   // 하향 논거
  argos:       'anthropic_haiku',   // 스크리닝
  aria:        'anthropic_haiku',   // 기술 분석
  chronos:     'anthropic_sonnet',  // 백테스팅 검증 — 정확도 중요
};

export interface HubLLMResult {
  ok: boolean;
  text: string;
  provider: string;
  costUsd: number;
  latencyMs: number;
  error?: string;
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
  } = {}
) {
  const abstractModel = AGENT_ABSTRACT_MODEL[agentName] ?? 'anthropic_haiku';
  const urgency = normalizeHubUrgency(options.urgency ?? (agentName === 'luna' ? 'high' : 'normal'));
  return {
    prompt:        userPrompt,
    systemPrompt,
    abstractModel,
    timeoutMs:     HUB_TIMEOUT_MS - 5_000,
    agent:         agentName,
    callerTeam:    options.callerTeam || getHubCallerTeam(),
    urgency,
    taskType:      'trade_signal',
    selectorKey:   'investment.agent_policy',
    market:        options.market || null,
    symbol:        options.symbol || null,
    maxTokens:     options.maxTokens,
  };
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
    shadowCompare?: string;  // Shadow Mode일 때 직접 호출 결과 (비교용)
  } = {}
): Promise<HubLLMResult> {
  const t0 = Date.now();

  let hubToken: string;
  try {
    const secrets = await _hubClient.fetchHubSecrets('config');
    hubToken = secrets?.hub_auth_token || process.env.HUB_AUTH_TOKEN || '';
  } catch {
    hubToken = process.env.HUB_AUTH_TOKEN || '';
  }

  if (!hubToken) {
    return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs: 0, error: 'HUB_AUTH_TOKEN 없음' };
  }

  const body = JSON.stringify(buildHubLlmCallPayload(agentName, systemPrompt, userPrompt, {
    maxTokens: options.maxTokens,
    symbol: options.symbol,
    market: options.market || process.env.INVESTMENT_MARKET || undefined,
    urgency: options.urgency,
  }));

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
      return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs, error: `HTTP ${res.status}` };
    }

    const json = await res.json();
    if (!json.ok) {
      console.warn(`[hub-llm] ${agentName} 응답 ok:false — ${json.error || '알 수 없음'}`);
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
      });
      return { ok: false, text, provider: json.provider || 'hub', costUsd, latencyMs };
    }

    console.log(`[hub-llm] ${agentName} ✓ provider=${json.provider} latency=${latencyMs}ms cost=$${costUsd.toFixed(5)}`);
    return { ok: true, text, provider: json.provider || 'hub', costUsd, latencyMs };

  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hub-llm] ${agentName} 오류: ${msg}`);
    return { ok: false, text: '', provider: 'hub', costUsd: 0, latencyMs, error: msg };
  }
}

// ─── Shadow 비교 로깅 ─────────────────────────────────────────────────

function _logShadowComparison(
  agentName: string,
  hubText: string,
  directText: string,
  meta: { provider: string; costUsd: number; latencyMs: number; market?: string; symbol?: string }
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
  meta: { provider: string; costUsd: number; latencyMs: number; market?: string; symbol?: string }
) {
  try {
    const pgPool = _require('../../../packages/core/lib/pg-pool');
    await pgPool.query(
      `INSERT INTO investment.llm_routing_log
         (agent_name, hub_text, direct_text, matched, provider, cost_usd, latency_ms, market, symbol, shadow_mode, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW())`,
      [
        agentName,
        hubText.slice(0, 2000),
        directText.slice(0, 2000),
        matched,
        meta.provider,
        meta.costUsd,
        meta.latencyMs,
        meta.market || null,
        meta.symbol || null,
      ]
    );
  } catch {
    // DB 저장 실패는 무시 (운영 중단 방지)
  }
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
  opts: { symbol?: string; market?: string; cacheTTL?: number } = {}
): Promise<string> {
  const shadow = isHubShadow();
  const enabled = isHubEnabled();

  if (!enabled && !shadow) {
    return directFn(agentName, systemPrompt, userMsg, maxTokens ?? 512, opts);
  }

  if (shadow) {
    // Shadow: Hub 호출(비동기, 로깅용) + 직접 호출(실제 결과)
    const directResult = await directFn(agentName, systemPrompt, userMsg, maxTokens ?? 512, opts);
    callViaHub(agentName, systemPrompt, userMsg, {
      maxTokens,
      symbol: opts.symbol,
      market: opts.market,
      shadowCompare: directResult,
    }).catch(() => {});
    return directResult;
  }

  // Hub 활성: Hub 우선, 실패 시 직접 호출 폴백
  const hubResult = await callViaHub(agentName, systemPrompt, userMsg, {
    maxTokens,
    symbol: opts.symbol,
    market: opts.market,
  });
  if (hubResult.ok) return hubResult.text;

  console.warn(`[hub-llm] ${agentName} Hub 실패(${hubResult.error}), 직접 호출 폴백`);
  return directFn(agentName, systemPrompt, userMsg, maxTokens ?? 512, opts);
}
