'use strict';

// 반복 패턴 감지
function detectRepetition(history, threshold) {
  const list = Array.isArray(history) ? history : [];
  const minCount = typeof threshold === 'number' && threshold > 0 ? threshold : 3;
  const buckets = {};

  // 프롬프트 앞 50자로 그룹핑
  for (const entry of list) {
    if (!entry || !entry.prompt) continue;
    const key = String(entry.prompt).slice(0, 50).trim().toLowerCase();
    if (!key) continue;
    if (!buckets[key]) {
      buckets[key] = { key, entries: [], count: 0 };
    }
    buckets[key].entries.push(entry);
    buckets[key].count += 1;
  }

  // threshold 이상 반복된 패턴만 반환
  const patterns = [];
  for (const bucket of Object.values(buckets)) {
    if (bucket.count >= minCount) {
      patterns.push({
        promptPrefix: bucket.key,
        count: bucket.count,
        samplePrompt: bucket.entries[0].prompt,
        sampleResponse: bucket.entries[0].response || '',
      });
    }
  }

  return patterns;
}

// 반복 패턴에서 if-then 규칙 생성
function generateRule(pattern) {
  if (!pattern) {
    console.warn('[skills/pattern-to-skill] 패턴 누락');
    return null;
  }

  return {
    condition: pattern.promptPrefix || pattern.samplePrompt || '',
    action: pattern.sampleResponse || '',
    count: pattern.count || 1,
    confidence: Math.min(1.0, (pattern.count || 0) * 0.1),
    savingsPerCall: 500, // 예상 토큰 절감 (기본값)
  };
}

// 규칙 적용 시 LLM 호출 절감 추정
function estimateSavings(rules) {
  const ruleList = Array.isArray(rules) ? rules : [];
  let totalCalls = 0;
  let ruledCalls = 0;
  let savedTokens = 0;

  for (const rule of ruleList) {
    if (!rule) continue;
    const calls = rule.count || 1;
    totalCalls += calls;
    ruledCalls += calls;
    savedTokens += calls * (rule.savingsPerCall || 500);
  }

  // 토큰당 비용 추정 (Claude Haiku 기준 대략적 추정)
  const costPerToken = 0.0000005;
  const savedCost = Math.round(savedTokens * costPerToken * 100) / 100;

  return { totalCalls, ruledCalls, savedTokens, savedCost };
}

module.exports = { detectRepetition, generateRule, estimateSavings };
