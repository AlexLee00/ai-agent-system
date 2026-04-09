'use strict';

function buildSpeedLookup(snapshot) {
  const lookup = new Map();
  for (const item of snapshot?.results || []) {
    if (item?.modelId) lookup.set(item.modelId, item);
    const short = String(item?.modelId || '').split('/').pop();
    if (short) lookup.set(short, item);
  }
  return lookup;
}

function normalizeChain(description) {
  if (!description) return [];
  if (Array.isArray(description?.chain)) return description.chain;
  const policy = description.policy || {};
  const chain = [];
  if (policy.primary) chain.push(policy.primary);
  if (Array.isArray(policy.fallbacks)) chain.push(...policy.fallbacks);
  if (!chain.length && Array.isArray(policy.fallbackChain)) chain.push(...policy.fallbackChain);
  return chain;
}

function getSpeedEntry(entry, speedLookup) {
  if (!entry || !speedLookup) return null;
  return speedLookup.get(entry.model) || null;
}

function buildSelectorAdvice(description, speedLookup) {
  const chain = normalizeChain(description);
  const primary = chain[0] || null;
  const fallback = chain[1] || null;
  const primarySpeed = getSpeedEntry(primary, speedLookup);
  const fallbackSpeed = getSpeedEntry(fallback, speedLookup);

  if (!primary) {
    return {
      decision: 'observe',
      reason: 'primary chain 없음',
      candidate: null,
    };
  }

  if (!primarySpeed) {
    return {
      decision: 'observe',
      reason: '최근 speed-test 측정값 없음',
      candidate: null,
    };
  }

  if (primarySpeed.ok !== true && fallbackSpeed?.ok === true) {
    return {
      decision: 'switch_candidate',
      reason: 'primary 측정 실패, fallback은 정상 응답',
      candidate: fallback ? `${fallback.provider}/${fallback.model}` : null,
    };
  }

  if (primarySpeed.ok !== true) {
    return {
      decision: 'observe',
      reason: `primary 측정 실패(${primarySpeed.error || 'error'})`,
      candidate: null,
    };
  }

  if (!fallback || !fallbackSpeed || fallbackSpeed.ok !== true) {
    return {
      decision: 'hold',
      reason: 'primary 정상, 비교 가능한 fallback 측정 부족',
      candidate: null,
    };
  }

  const primaryTotal = Number(primarySpeed.total || 0);
  const fallbackTotal = Number(fallbackSpeed.total || 0);
  const primaryTtft = Number(primarySpeed.ttft || 0);
  const fallbackTtft = Number(fallbackSpeed.ttft || 0);

  const totalGap = primaryTotal > 0 ? ((primaryTotal - fallbackTotal) / primaryTotal) : 0;
  const ttftGap = primaryTtft > 0 ? ((primaryTtft - fallbackTtft) / primaryTtft) : 0;
  const fallbackFaster = fallbackTotal > 0 && totalGap >= 0.2;
  const fallbackTtftFaster = fallbackTtft > 0 && ttftGap >= 0.2;

  if (fallbackFaster || fallbackTtftFaster) {
    return {
      decision: 'compare',
      reason: `fallback이 primary 대비 더 빠름(total ${primaryTotal}ms -> ${fallbackTotal}ms, ttft ${primaryTtft}ms -> ${fallbackTtft}ms)`,
      candidate: `${fallback.provider}/${fallback.model}`,
    };
  }

  return {
    decision: 'hold',
    reason: 'primary가 정상이며 fallback 우위가 크지 않음',
    candidate: null,
  };
}

module.exports = {
  buildSpeedLookup,
  normalizeChain,
  buildSelectorAdvice,
};
