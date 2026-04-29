// @ts-nocheck
/**
 * shared/agent-llm-routing.ts — 에이전트 × 시장 × 태스크 → 최적 LLM 매트릭스
 *
 * Kill Switch:
 *   LUNA_AGENT_LLM_ROUTING_ENABLED=false → 기존 AGENT_ABSTRACT_MODEL 사용 (하위 호환)
 *   LUNA_AGENT_LLM_ROUTING_FORCE_AGENT_LEVEL=false → agent-level 라우팅 비활성
 */
import { isAgentMemoryFeatureEnabled } from './agent-memory-runtime.ts';

export type AgentName =
  | 'luna' | 'nemesis' | 'aria' | 'sophia' | 'argos' | 'hermes'
  | 'oracle' | 'chronos' | 'zeus' | 'athena' | 'sentinel' | 'adaptive-risk'
  | 'hephaestos' | 'hanul' | 'budget' | 'scout';

export type MarketType = 'crypto' | 'domestic' | 'overseas' | 'any';

export type TaskType =
  | 'final_decision'   // luna 최종 판단
  | 'risk_eval'        // nemesis 리스크
  | 'technical_analysis' // aria 기술 분석
  | 'sentiment'        // sophia/hermes 감성
  | 'screening'        // argos 스크리닝
  | 'onchain'          // oracle 온체인
  | 'backtest'         // chronos 백테스팅
  | 'debate_bull'      // zeus 상향 논거
  | 'debate_bear'      // athena 하향 논거
  | 'anomaly_detect'   // sentinel 이상 탐지
  | 'execution'        // hephaestos/hanul 실행
  | 'capital'          // budget 자본 관리
  | 'default';         // 기타

export interface LLMRoute {
  /** Hub abstract model key 또는 직접 라우트 (provider/model) */
  primary: string;
  /** 폴백 체인 (순서대로 시도) */
  fallbacks: string[];
  /** rule-based라 LLM 불필요 */
  noLLM?: boolean;
}

export interface HubChainEntry {
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface HubRoutingPlan {
  enabled: boolean;
  route: LLMRoute;
  abstractModel: 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus';
  chain: HubChainEntry[];
}

function isRoutingEnabled(): boolean {
  return isAgentMemoryFeatureEnabled('llmRoutingEnabled');
}

function normalizeRoutingMarket(market: MarketType | string = 'any'): MarketType {
  const raw = String(market || '').trim().toLowerCase();
  if (raw === 'binance' || raw === 'crypto') return 'crypto';
  if (raw === 'kis' || raw === 'domestic' || raw === 'kr') return 'domestic';
  if (raw === 'kis_overseas' || raw === 'overseas' || raw === 'us') return 'overseas';
  return 'any';
}

function normalizeRoutingTask(task: TaskType | string = 'default'): TaskType | string {
  const raw = String(task || '').trim().toLowerCase();
  if (!raw) return 'default';
  return raw;
}

// ─── 라우팅 결정 함수 ────────────────────────────────────────────────────────

/**
 * 에이전트 × 시장 × 태스크 조합에서 최적 LLM 라우트 반환.
 * 매트릭스에 없으면 기본값(anthropic_haiku)으로 폴백.
 */
export function resolveAgentLLMRoute(
  agent: AgentName | string,
  market: MarketType | string = 'any',
  task: TaskType | string = 'default',
): LLMRoute {
  const normalizedMarket = normalizeRoutingMarket(market);
  const normalizedTask = normalizeRoutingTask(task);
  if (!isRoutingEnabled()) {
    return LEGACY_FALLBACK[agent] ?? DEFAULT_ROUTE;
  }

  // 1. exact match: agent + market + task
  const exact = ROUTING_MATRIX[`${agent}:${normalizedMarket}:${normalizedTask}`];
  if (exact) return exact;

  // 2. agent + any + task
  const agentTask = ROUTING_MATRIX[`${agent}:any:${normalizedTask}`];
  if (agentTask) return agentTask;

  // 3. agent + market + default
  const agentMarket = ROUTING_MATRIX[`${agent}:${normalizedMarket}:default`];
  if (agentMarket) return agentMarket;

  // 4. agent-level default
  const agentDefault = AGENT_DEFAULTS[agent];
  if (agentDefault) return agentDefault;

  return DEFAULT_ROUTE;
}

/** abstract model 키 → Hub 라우트 문자열로 변환 */
export function routeToAbstractModel(route: LLMRoute): string {
  return route.primary;
}

// ─── 기본값 ─────────────────────────────────────────────────────────────────

const DEFAULT_ROUTE: LLMRoute = {
  primary: 'anthropic_haiku',
  fallbacks: ['groq_fast', 'local_fast'],
};

// 기존 AGENT_ABSTRACT_MODEL 하위 호환 매핑
const LEGACY_FALLBACK: Record<string, LLMRoute> = {
  luna:    { primary: 'anthropic_sonnet', fallbacks: ['openai-oauth/gpt-5.4', 'groq_versatile'] },
  chronos: { primary: 'anthropic_sonnet', fallbacks: ['openai-oauth/gpt-5.4', 'groq_versatile'] },
};

// ─── 에이전트별 기본 라우트 ──────────────────────────────────────────────────

const AGENT_DEFAULTS: Record<string, LLMRoute> = {
  // 🌙 luna — 사령탑: 긴 컨텍스트 + 한국어 추론 강점
  luna: {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/llama-3.3-70b-versatile', 'claude-code/haiku'],
  },

  // 🛡️ nemesis — 리스크: critical 경로, 속도 우선
  nemesis: {
    primary: 'groq/qwen3-32b',
    fallbacks: ['claude-code/haiku', 'openai-oauth/gpt-5.4-mini'],
  },

  // 📊 aria — 기술 분석: 수학 연산 위주, LLM 최소화
  aria: {
    primary: 'rule-based',
    fallbacks: ['claude-code/haiku'],
    noLLM: true,
  },

  // 🧠 sophia — 감성: 다국어 강점 (한/영/중)
  sophia: {
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'claude-code/haiku'],
  },

  // 👁️ argos — 스크리닝: 대량 처리 + 빠른 분류
  argos: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-oauth/gemini-2.5-flash'],
  },

  // 📜 hermes — 뉴스: 다국어 매핑
  hermes: {
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['claude-code/haiku', 'openai-oauth/gpt-5.4-mini'],
  },

  // 🔮 oracle — 온체인: 복잡한 추론 + 통합
  oracle: {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/qwen3-32b'],
  },

  // ⏰ chronos — 백테스팅: 정확도 critical
  chronos: {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/qwen3-32b'],
  },

  // 🦅 zeus — 매수 논거: 중간 품질 + 빠름
  zeus: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku', 'groq/llama-3.3-70b-versatile'],
  },

  // 🏛️ athena — 매도 논거: zeus와 동급
  athena: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku', 'groq/llama-3.3-70b-versatile'],
  },

  // 🛂 sentinel — 이상 탐지: 빠른 분류
  sentinel: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku'],
  },

  // ⚡ adaptive-risk — 빠른 리스크 분기
  'adaptive-risk': {
    primary: 'groq/qwen3-32b',
    fallbacks: ['claude-code/haiku'],
  },

  // 🔥 hephaestos — 바이낸스 실행: rule-based
  hephaestos: {
    primary: 'rule-based',
    fallbacks: ['groq/qwen3-32b'],
    noLLM: true,
  },

  // 🇰🇷 hanul — KIS 실행: rule-based
  hanul: {
    primary: 'rule-based',
    fallbacks: ['groq/qwen3-32b'],
    noLLM: true,
  },

  // 💰 budget — 자본 관리: 수학만
  budget: {
    primary: 'rule-based',
    fallbacks: [],
    noLLM: true,
  },

  // 🔭 scout — 스크리닝 보조
  scout: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile'],
  },
};

// ─── 상세 라우팅 매트릭스 (agent:market:task → LLMRoute) ─────────────────────
// 형식: ROUTING_MATRIX['agent:market:task'] = { primary, fallbacks }
// market: crypto | domestic | overseas | any
// task:   final_decision | risk_eval | sentiment | ... | default

const ROUTING_MATRIX: Record<string, LLMRoute> = {
  // ── luna ──────────────────────────────────────────────────────────────────
  // 암호화폐 최종 판단: claude-sonnet (한국어 추론 + 긴 컨텍스트)
  'luna:crypto:final_decision': {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/llama-3.3-70b-versatile', 'claude-code/haiku'],
  },
  // 국내장 최종 판단: claude-sonnet (한국어 강점)
  'luna:domestic:final_decision': {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/llama-3.3-70b-versatile'],
  },
  // 국외장 최종 판단
  'luna:overseas:final_decision': {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/llama-3.3-70b-versatile'],
  },

  // ── nemesis ────────────────────────────────────────────────────────────────
  // 리스크 평가: groq 최속 (critical 경로)
  'nemesis:any:risk_eval': {
    primary: 'groq/qwen3-32b',
    fallbacks: ['claude-code/haiku', 'openai-oauth/gpt-5.4-mini'],
  },

  // ── aria ───────────────────────────────────────────────────────────────────
  // 기술 분석: rule-based (RSI/MACD 수학), LLM 불필요
  'aria:any:technical_analysis': {
    primary: 'rule-based',
    fallbacks: ['claude-code/haiku'],
    noLLM: true,
  },

  // ── sophia ─────────────────────────────────────────────────────────────────
  // 감성 분석: gemini-flash (multilingual 최강)
  'sophia:crypto:sentiment': {
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'claude-code/haiku'],
  },
  'sophia:domestic:sentiment': {
    // 한국어 감성: gemini-flash (한국어 지원 우수)
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['claude-code/haiku', 'openai-oauth/gpt-5.4-mini'],
  },
  'sophia:overseas:sentiment': {
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'claude-code/haiku'],
  },

  // ── argos ──────────────────────────────────────────────────────────────────
  // 스크리닝: gpt-5.4-mini (대량 처리 + 고속)
  'argos:any:screening': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-oauth/gemini-2.5-flash'],
  },

  // ── hermes ─────────────────────────────────────────────────────────────────
  // 뉴스 다국어: gemini-flash (Google News 통합 + 한/영/중)
  'hermes:any:sentiment': {
    primary: 'gemini-oauth/gemini-2.5-flash',
    fallbacks: ['claude-code/haiku', 'openai-oauth/gpt-5.4-mini'],
  },

  // ── oracle ─────────────────────────────────────────────────────────────────
  // 온체인 + 파생상품: claude-sonnet (복잡 추론)
  'oracle:crypto:onchain': {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/qwen3-32b'],
  },

  // ── chronos ────────────────────────────────────────────────────────────────
  // 백테스팅: claude-sonnet (정확도 critical)
  'chronos:any:backtest': {
    primary: 'claude-code/sonnet',
    fallbacks: ['openai-oauth/gpt-5.4', 'groq/qwen3-32b'],
  },

  // ── zeus / athena ──────────────────────────────────────────────────────────
  // 토론 논거: gpt-5.4-mini (중간 품질 + 빠름 + 저비용)
  'zeus:any:debate_bull': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku', 'groq/llama-3.3-70b-versatile'],
  },
  'athena:any:debate_bear': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku', 'groq/llama-3.3-70b-versatile'],
  },

  // ── sentinel ───────────────────────────────────────────────────────────────
  'sentinel:any:anomaly_detect': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['claude-code/haiku'],
  },
};

// ─── 유틸 ────────────────────────────────────────────────────────────────────

/**
 * 라우팅 결정이 rule-based(LLM 없음)인지 확인
 */
export function isNoLLMAgent(agent: string, market?: string, task?: string): boolean {
  const route = resolveAgentLLMRoute(agent, market || 'any', task || 'default');
  return route.noLLM === true;
}

/**
 * Hub buildHubLlmCallPayload에서 쓸 abstractModel 문자열 반환.
 * 직접 provider/model 형식이면 그대로, legacy key면 그대로 반환.
 */
export function getAbstractModelForHub(agent: string, market?: string, task?: string): string {
  if (!isRoutingEnabled()) {
    // 기존 하위 호환 매핑
    const legacy: Record<string, string> = {
      luna:    'anthropic_sonnet',
      chronos: 'anthropic_sonnet',
    };
    return legacy[agent] ?? 'anthropic_haiku';
  }
  const route = resolveAgentLLMRoute(agent, market || 'any', task || 'default');
  const key = String(route?.primary || '').toLowerCase();
  if (key.includes('opus')) return 'anthropic_opus';
  if (key.includes('sonnet')) return 'anthropic_sonnet';
  return 'anthropic_haiku';
}

function routeToChainEntry(routeKey: string, maxTokens?: number): HubChainEntry | null {
  const normalized = String(routeKey || '').trim();
  if (!normalized || normalized === 'rule-based') return null;
  const [providerRaw, ...rest] = normalized.split('/');
  const modelRaw = rest.join('/').trim();
  if (!providerRaw || !modelRaw) return null;

  let provider = providerRaw.trim().toLowerCase();
  let model = modelRaw;
  if (provider === 'claude-code') {
    provider = 'claude-code';
    model = modelRaw.replace(/^claude-code\//, '');
  } else if (provider === 'openai' || provider === 'openai-oauth') {
    provider = 'openai-oauth';
    model = modelRaw.replace(/^openai-oauth\//, '').replace(/^openai\//, '');
  } else if (provider === 'groq') {
    provider = 'groq';
    model = modelRaw.replace(/^groq\//, '');
  } else if (provider === 'gemini' || provider === 'gemini-oauth') {
    provider = 'gemini-oauth';
    model = modelRaw.replace(/^gemini-oauth\//, '').replace(/^gemini\//, '');
  } else if (provider === 'gemini-cli-oauth' || provider === 'gemini-codeassist-oauth') {
    provider = providerRaw;
  }

  const entry: HubChainEntry = { provider, model };
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) {
    entry.maxTokens = Math.round(Number(maxTokens));
  }
  return entry;
}

export function compileHubRoutingChain(route: LLMRoute, maxTokens?: number): HubChainEntry[] {
  const ordered = [route?.primary, ...(Array.isArray(route?.fallbacks) ? route.fallbacks : [])]
    .map((item) => routeToChainEntry(String(item || ''), maxTokens))
    .filter(Boolean) as HubChainEntry[];
  const deduped: HubChainEntry[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function resolveHubRoutingPlan(
  agent: AgentName | string,
  market: MarketType | string = 'any',
  task: TaskType | string = 'default',
  maxTokens?: number,
): HubRoutingPlan {
  const route = resolveAgentLLMRoute(agent, market, task);
  return {
    enabled: isRoutingEnabled(),
    route,
    abstractModel: getAbstractModelForHub(agent, market, task) as HubRoutingPlan['abstractModel'],
    chain: compileHubRoutingChain(route, maxTokens),
  };
}
