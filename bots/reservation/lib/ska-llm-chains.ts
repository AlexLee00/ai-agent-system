/**
 * ska-llm-chains.ts — 스카팀 LLM 폴백 체인 설정
 *
 * 스카팀 LLM 전략:
 *   - 99% 정상: CSS/XPath (Level 1/2) — LLM 호출 없음!
 *   - 1% 예외: LLM 스킬 on-demand 호출
 *
 * 폴백 체인:
 *   Primary:    OpenAI Codex OAuth (gpt-5.4)
 *   Fallback 1: Groq (llama-3.1-8b-instant)
 *
 * 예상 비용: 월 $1~3 (파싱 실패 50~100회, 토큰 500~1000/회)
 * 월 $10 초과 시 token-tracker 알림!
 */

type FallbackChainEntry = {
  provider: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
};

/** Level 3 파싱 체인 — CSS/XPath 모두 실패 시 */
export const SKA_PARSING_CHAIN: FallbackChainEntry[] = [
  {
    provider: 'openai-oauth',
    model: 'gpt-5.4',
    maxTokens: 2000,
    temperature: 0.1,
    timeoutMs: 15_000,
  },
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    maxTokens: 2000,
    temperature: 0.1,
    timeoutMs: 10_000,
  },
];

/** 셀렉터 자동 생성 체인 — LLM 파싱 성공 후 CSS 셀렉터 생성 */
export const SKA_SELECTOR_GEN_CHAIN: FallbackChainEntry[] = [
  {
    provider: 'openai-oauth',
    model: 'gpt-5.4',
    maxTokens: 1000,
    temperature: 0.1,
    timeoutMs: 10_000,
  },
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    maxTokens: 1000,
    temperature: 0.1,
    timeoutMs: 8_000,
  },
];

/** 복잡 에러 분류 체인 — FailureTracker 규칙으로 분류 불가 시 */
export const SKA_CLASSIFY_CHAIN: FallbackChainEntry[] = [
  {
    provider: 'openai-oauth',
    model: 'gpt-5.4-mini',
    maxTokens: 500,
    temperature: 0,
    timeoutMs: 8_000,
  },
  {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    maxTokens: 500,
    temperature: 0,
    timeoutMs: 6_000,
  },
];

/** chain_id → chain 매핑 (Elixir PortBridge 경유 호출 시 사용) */
export const SKA_CHAIN_REGISTRY: Record<string, FallbackChainEntry[]> = {
  'ska.parsing.level3': SKA_PARSING_CHAIN,
  'ska.selector.generate': SKA_SELECTOR_GEN_CHAIN,
  'ska.classify': SKA_CLASSIFY_CHAIN,
};
