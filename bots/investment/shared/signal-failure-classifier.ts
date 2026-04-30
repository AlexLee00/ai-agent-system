// @ts-nocheck
const RULES = [
  { kind: 'price_drift', retryable: true, delayMs: 5 * 60_000, patterns: ['price_drift', 'slippage', '가격 이탈'] },
  { kind: 'capital_exceeded', retryable: true, delayMs: 30 * 60_000, patterns: ['capital', 'buying_power', 'insufficient', '잔고', '예산'] },
  { kind: 'market_closed', retryable: true, delayMs: 60 * 60_000, patterns: ['market_closed', '장 종료', 'closed market'] },
  { kind: 'min_order', retryable: true, delayMs: 10 * 60_000, patterns: ['min_order', 'minimum', '최소 주문'] },
  { kind: 'provider_unavailable', retryable: true, delayMs: 60_000, patterns: ['provider_cooldown', 'llm', 'oauth', 'rate limit'] },
  { kind: 'manual_reconcile_required', retryable: false, delayMs: null, patterns: ['manual_reconcile', 'ambiguous_fill'] },
];

export function classifySignalFailure(input = {}) {
  const text = [
    input.reason,
    input.error,
    input.code,
    input.status,
    input.message,
    JSON.stringify(input.meta || {}),
  ].filter(Boolean).join(' ').toLowerCase();
  const matched = RULES.find((rule) => rule.patterns.some((pattern) => text.includes(String(pattern).toLowerCase())));
  const rule = matched || { kind: 'unknown', retryable: false, delayMs: null, patterns: [] };
  return {
    kind: rule.kind,
    retryable: rule.retryable,
    delayMs: rule.delayMs,
    nextAction: rule.retryable ? 'defer_for_recovery' : 'manual_review',
    confidence: matched ? 0.85 : 0.35,
    evidence: { matchedPatterns: matched?.patterns || [], textSample: text.slice(0, 240) },
  };
}

export default { classifySignalFailure };
