// @ts-nocheck
/**
 * shared/agent-llm-routing.ts
 *
 * Investment agent → Hub selector key adapter.
 *
 * Model/provider ownership is centralized in packages/core/lib/llm-model-selector.ts.
 * This module only maps Luna agent/task context to selector keys and preserves
 * the previous public API used by hub-llm-client.ts and smokes.
 */
import { createRequire } from 'node:module';
import { isAgentMemoryFeatureEnabled } from './agent-memory-runtime.ts';

const require = createRequire(import.meta.url);
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.js');

export type AgentName =
  | 'luna' | 'nemesis' | 'aria' | 'sophia' | 'argos' | 'hermes'
  | 'oracle' | 'chronos' | 'zeus' | 'athena' | 'sentinel' | 'adaptive-risk'
  | 'hephaestos' | 'hanul' | 'budget' | 'scout' | 'kairos' | 'stock-flow' | 'sweeper' | 'reporter';

export type MarketType = 'crypto' | 'domestic' | 'overseas' | 'any';

export type TaskType =
  | 'final_decision'
  | 'risk_eval'
  | 'technical_analysis'
  | 'sentiment'
  | 'screening'
  | 'onchain'
  | 'backtest'
  | 'debate_bull'
  | 'debate_bear'
  | 'anomaly_detect'
  | 'execution'
  | 'capital'
  | 'prediction'
  | 'flow'
  | 'operations'
  | 'reporting'
  | 'default';

export interface LLMRoute {
  /** Hub selector key. Kept as primary for API compatibility. */
  primary: string;
  /** Selector-derived fallback route labels. Compatibility/reporting only. */
  fallbacks: string[];
  /** rule-based라 LLM 불필요 */
  noLLM?: boolean;
  selectorKey?: string;
}

export interface HubChainEntry {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface HubRoutingPlan {
  enabled: boolean;
  route: LLMRoute;
  abstractModel: 'anthropic_haiku' | 'anthropic_sonnet' | 'anthropic_opus';
  chain: HubChainEntry[];
  selectorKey: string | null;
}

const SELECTOR_VERSION = 'v3.0_oauth_4';
const ROLLOUT_PERCENT = 100;

const RULE_BASED_AGENTS = new Set(['aria', 'hephaestos', 'hanul', 'budget']);

const AGENT_SELECTOR_KEYS: Record<string, string> = {
  luna: 'investment.luna',
  nemesis: 'investment.nemesis',
  aria: 'investment.aria',
  sophia: 'investment.sophia',
  argos: 'investment.argos',
  hermes: 'investment.hermes',
  oracle: 'investment.oracle',
  chronos: 'investment.chronos',
  zeus: 'investment.zeus',
  athena: 'investment.athena',
  sentinel: 'investment.sentinel',
  'adaptive-risk': 'investment.adaptive-risk',
  hephaestos: 'investment.hephaestos',
  hanul: 'investment.hanul',
  budget: 'investment.budget',
  scout: 'investment.scout',
  kairos: 'investment.kairos',
  'stock-flow': 'investment.stock-flow',
  sweeper: 'investment.sweeper',
  reporter: 'investment.reporter',
};

const TASK_SELECTOR_KEYS: Record<string, string> = {
  'luna:any:final_decision': 'investment.luna',
  'luna:crypto:final_decision': 'investment.luna',
  'luna:domestic:final_decision': 'investment.luna',
  'luna:overseas:final_decision': 'investment.luna',
  'nemesis:any:risk_eval': 'investment.nemesis',
  'aria:any:technical_analysis': 'investment.aria',
  'sophia:any:sentiment': 'investment.sophia',
  'sophia:crypto:sentiment': 'investment.sophia',
  'sophia:domestic:sentiment': 'investment.sophia',
  'sophia:overseas:sentiment': 'investment.sophia',
  'argos:any:screening': 'investment.argos',
  'hermes:any:sentiment': 'investment.hermes',
  'oracle:crypto:onchain': 'investment.oracle',
  'oracle:any:onchain': 'investment.oracle',
  'chronos:any:backtest': 'investment.chronos',
  'zeus:any:debate_bull': 'investment.zeus',
  'athena:any:debate_bear': 'investment.athena',
  'sentinel:any:anomaly_detect': 'investment.sentinel',
  'kairos:any:prediction': 'investment.kairos',
  'stock-flow:any:flow': 'investment.stock-flow',
  'sweeper:any:operations': 'investment.sweeper',
  'reporter:any:reporting': 'investment.reporter',
};

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
  return raw || 'default';
}

function routeLabel(entry: HubChainEntry): string {
  if (!entry?.provider || !entry?.model) return '';
  const model = String(entry.model);
  return model.startsWith(`${entry.provider}/`) ? model : `${entry.provider}/${model}`;
}

function chainForSelector(selectorKey: string, agent: string, maxTokens?: number): HubChainEntry[] {
  return selectLLMChain(selectorKey, {
    agentName: agent,
    maxTokens,
    selectorVersion: SELECTOR_VERSION,
    rolloutPercent: ROLLOUT_PERCENT,
    rolloutKey: `investment-agent:${agent}`,
  }) as HubChainEntry[];
}

export function selectorKeyForAgentTask(
  agent: AgentName | string,
  market: MarketType | string = 'any',
  task: TaskType | string = 'default',
): string {
  const normalizedAgent = String(agent || '').trim().toLowerCase() || 'default';
  const normalizedMarket = normalizeRoutingMarket(market);
  const normalizedTask = normalizeRoutingTask(task);
  return TASK_SELECTOR_KEYS[`${normalizedAgent}:${normalizedMarket}:${normalizedTask}`]
    || TASK_SELECTOR_KEYS[`${normalizedAgent}:any:${normalizedTask}`]
    || AGENT_SELECTOR_KEYS[normalizedAgent]
    || 'investment._default';
}

/**
 * 에이전트 × 시장 × 태스크 조합에서 Hub selector-backed route 반환.
 * 모델/프로바이더는 selector가 결정하며, 이 함수는 compatibility route
 * labels만 materialize한다.
 */
export function resolveAgentLLMRoute(
  agent: AgentName | string,
  market: MarketType | string = 'any',
  task: TaskType | string = 'default',
): LLMRoute {
  const normalizedAgent = String(agent || '').trim().toLowerCase();
  const selectorKey = selectorKeyForAgentTask(normalizedAgent, market, task);
  if (RULE_BASED_AGENTS.has(normalizedAgent)) {
    return { primary: selectorKey, fallbacks: [], noLLM: true, selectorKey };
  }
  const chain = chainForSelector(selectorKey, normalizedAgent);
  const labels = chain.map(routeLabel).filter(Boolean);
  return {
    primary: selectorKey,
    fallbacks: labels.slice(1),
    selectorKey,
  };
}

/** abstract model 키 → Hub selector key로 변환 */
export function routeToAbstractModel(route: LLMRoute): string {
  return route.selectorKey || route.primary || 'investment._default';
}

/**
 * 라우팅 결정이 rule-based(LLM 없음)인지 확인
 */
export function isNoLLMAgent(agent: string, market?: string, task?: string): boolean {
  const route = resolveAgentLLMRoute(agent, market || 'any', task || 'default');
  return route.noLLM === true;
}

/**
 * Hub schema 호환용 abstractModel. 실제 모델 선택은 selectorKey가 결정한다.
 */
export function getAbstractModelForHub(_agent: string, _market?: string, _task?: string): string {
  return 'anthropic_haiku';
}

export function compileHubRoutingChain(route: LLMRoute, maxTokens?: number): HubChainEntry[] {
  if (!route?.selectorKey || route.noLLM) return [];
  return chainForSelector(route.selectorKey, String(route.selectorKey).split('.').pop() || 'default', maxTokens);
}

export function resolveHubRoutingPlan(
  agent: AgentName | string,
  market: MarketType | string = 'any',
  task: TaskType | string = 'default',
  maxTokens?: number,
): HubRoutingPlan {
  const route = resolveAgentLLMRoute(agent, market, task);
  const chain = compileHubRoutingChain(route, maxTokens);
  return {
    enabled: isRoutingEnabled(),
    route,
    abstractModel: getAbstractModelForHub(agent, market, task) as HubRoutingPlan['abstractModel'],
    chain,
    selectorKey: route.selectorKey || null,
  };
}
