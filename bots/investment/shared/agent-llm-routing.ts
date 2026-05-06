// @ts-nocheck
/**
 * shared/agent-llm-routing.ts — 에이전트 × 시장 × 태스크 → 최적 LLM 매트릭스
 *
 * Kill Switch:
 *   LUNA_AGENT_LLM_ROUTING_ENABLED=false → legacy agent mapping 사용 (Luna/Chronos는 안전 fallback chain 유지)
 *   LUNA_AGENT_LLM_ROUTING_FORCE_AGENT_LEVEL=false → agent-level 라우팅 비활성
 */
import { isAgentMemoryFeatureEnabled } from './agent-memory-runtime.ts';

export type AgentName =
  | 'luna' | 'nemesis' | 'aria' | 'sophia' | 'argos' | 'hermes'
  | 'oracle' | 'chronos' | 'zeus' | 'athena' | 'sentinel' | 'adaptive-risk'
  | 'hephaestos' | 'hanul' | 'budget' | 'scout' | 'kairos' | 'stock-flow' | 'sweeper' | 'reporter';

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
  | 'prediction'       // kairos 예측 검증
  | 'flow'             // stock-flow 수급/거래량 구조
  | 'operations'       // sweeper 운영 정합성
  | 'reporting'        // reporter 운영 리포트
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
  primary: 'openai-oauth/gpt-5.4-mini',
  fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
};

// 기존 AGENT_ABSTRACT_MODEL 하위 호환 매핑
const LEGACY_FALLBACK: Record<string, LLMRoute> = {
  luna:    { primary: 'openai-oauth/gpt-5.4', fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'] },
  chronos: { primary: 'openai-oauth/gpt-5.4', fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'] },
  zeus:    { primary: 'openai-oauth/gpt-5.4-mini', fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'] },
  athena:  { primary: 'openai-oauth/gpt-5.4-mini', fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'] },
  hermes:  { primary: 'groq/llama-3.3-70b-versatile', fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'] },
  sophia:  { primary: 'groq/llama-3.3-70b-versatile', fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'] },
  oracle:  { primary: 'openai-oauth/gpt-5.4', fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'] },
  nemesis: { primary: 'openai-oauth/gpt-5.4-mini', fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'] },
};

// ─── 에이전트별 기본 라우트 ──────────────────────────────────────────────────

const AGENT_DEFAULTS: Record<string, LLMRoute> = {
  // 🌙 luna — 사령탑: 현재 healthy OAuth chain 우선
  luna: {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🛡️ nemesis — 리스크: critical 경로, OpenAI OAuth 우선으로 Claude quota 압박을 낮춘다.
  nemesis: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 📊 aria — 기술 분석: 수학 연산 위주, LLM 최소화
  aria: {
    primary: 'rule-based',
    fallbacks: [],
    noLLM: true,
  },

  // 🧠 sophia — 감성: 운영 hot path. 실측상 Groq가 가장 안정적이고 빠르다.
  sophia: {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 👁️ argos — 스크리닝: 대량 처리 + 빠른 분류
  argos: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 📜 hermes — 뉴스: 운영 hot path. Gemini/Claude OAuth는 fallback으로만 둔다.
  hermes: {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🔮 oracle — 온체인: 복잡한 추론 + 통합
  oracle: {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ⏰ chronos — 백테스팅: 정확도 critical
  chronos: {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🦅 zeus — 매수 논거: 중간 품질 + 빠름
  zeus: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🏛️ athena — 매도 논거: zeus와 동급
  athena: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🛂 sentinel — 이상 탐지: 빠른 분류
  sentinel: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ⚡ adaptive-risk — 빠른 리스크 분기
  'adaptive-risk': {
    primary: 'groq/qwen/qwen3-32b',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🔥 hephaestos — 바이낸스 실행: rule-based
  hephaestos: {
    primary: 'rule-based',
    fallbacks: ['groq/qwen/qwen3-32b'],
    noLLM: true,
  },

  // 🇰🇷 hanul — KIS 실행: rule-based
  hanul: {
    primary: 'rule-based',
    fallbacks: ['groq/qwen/qwen3-32b'],
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

  // 🔭 kairos — 예측 검증: 성능 모델 우선, reasoning Groq 폴백
  kairos: {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🌊 stock-flow — 수급 구조: 빠른 reasoning Groq 우선
  'stock-flow': {
    primary: 'groq/qwen/qwen3-32b',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // 🧹 sweeper — 장부/지갑 정합성: 빠른 운영 판단
  sweeper: {
    primary: 'groq/llama-3.1-8b-instant',
    fallbacks: ['openai-oauth/gpt-5.4-mini'],
  },

  // 🧾 reporter — 운영 보고: 빠른 요약 + OAuth fallback
  reporter: {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
};

// ─── 상세 라우팅 매트릭스 (agent:market:task → LLMRoute) ─────────────────────
// 형식: ROUTING_MATRIX['agent:market:task'] = { primary, fallbacks }
// market: crypto | domestic | overseas | any
// task:   final_decision | risk_eval | sentiment | ... | default

const ROUTING_MATRIX: Record<string, LLMRoute> = {
  // ── luna ──────────────────────────────────────────────────────────────────
  // 암호화폐 최종 판단: 현재 healthy OAuth chain 우선
  'luna:crypto:final_decision': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  // 국내장 최종 판단
  'luna:domestic:final_decision': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  // 국외장 최종 판단
  'luna:overseas:final_decision': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── nemesis ────────────────────────────────────────────────────────────────
  // 리스크 평가: groq 최속 (critical 경로)
  'nemesis:any:risk_eval': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── aria ───────────────────────────────────────────────────────────────────
  // 기술 분석: rule-based (RSI/MACD 수학), LLM 불필요
  'aria:any:technical_analysis': {
    primary: 'rule-based',
    fallbacks: [],
    noLLM: true,
  },

  // ── sophia ─────────────────────────────────────────────────────────────────
  // 감성 분석: 운영 hot path는 Groq 우선. OAuth 계열은 timeout/quota 시 fallback.
  'sophia:crypto:sentiment': {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  'sophia:domestic:sentiment': {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  'sophia:overseas:sentiment': {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── argos ──────────────────────────────────────────────────────────────────
  // 스크리닝: gpt-5.4-mini (대량 처리 + 고속)
  'argos:any:screening': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── hermes ─────────────────────────────────────────────────────────────────
  // 뉴스 다국어: 운영 실측상 Groq primary가 timeout 병목을 줄인다.
  'hermes:any:sentiment': {
    primary: 'groq/llama-3.3-70b-versatile',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── oracle ─────────────────────────────────────────────────────────────────
  // 온체인 + 파생상품: gpt-5.4 우선, Groq reasoning 폴백
  'oracle:crypto:onchain': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── chronos ────────────────────────────────────────────────────────────────
  // 백테스팅: gpt-5.4 우선, Groq reasoning 폴백
  'chronos:any:backtest': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── zeus / athena ──────────────────────────────────────────────────────────
  // 토론 논거: gpt-5.4-mini (중간 품질 + 빠름 + 저비용)
  'zeus:any:debate_bull': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  'athena:any:debate_bear': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── sentinel ───────────────────────────────────────────────────────────────
  'sentinel:any:anomaly_detect': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
  },

  // ── kairos / stock-flow / sweeper ────────────────────────────────────────
  'kairos:any:prediction': {
    primary: 'openai-oauth/gpt-5.4',
    fallbacks: ['groq/qwen/qwen3-32b', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  'stock-flow:any:flow': {
    primary: 'groq/qwen/qwen3-32b',
    fallbacks: ['openai-oauth/gpt-5.4-mini', 'gemini-cli-oauth/gemini-2.5-flash'],
  },
  'sweeper:any:operations': {
    primary: 'groq/llama-3.1-8b-instant',
    fallbacks: ['openai-oauth/gpt-5.4-mini'],
  },
  'reporter:any:reporting': {
    primary: 'openai-oauth/gpt-5.4-mini',
    fallbacks: ['groq/llama-3.3-70b-versatile', 'gemini-cli-oauth/gemini-2.5-flash'],
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
