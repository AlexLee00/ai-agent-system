#!/usr/bin/env tsx
/**
 * Claude Code OAuth + Groq Fallback 통합 테스트 스크립트
 *
 * lib/llm/* 모듈 검증용 CLI 테스트.
 * `tsx bots/hub/scripts/claude-code-oauth-test.ts` 로 직접 실행.
 */

import { callClaudeCodeOAuth } from '../lib/llm/claude-code-oauth';
import { callGroqFallback } from '../lib/llm/groq-fallback';
import { callWithFallback } from '../lib/llm/unified-caller';

async function main() {
  console.log('🧪 Claude Code OAuth + Groq 통합 테스트\n');

  // 테스트 1: Haiku OAuth
  console.log('[1/5] Claude Code OAuth — haiku');
  const r1 = await callClaudeCodeOAuth({ prompt: '한국의 수도는?', model: 'haiku', timeoutMs: 30_000 });
  console.log(`  → ok=${r1.ok}, ${r1.durationMs}ms, $${r1.totalCostUsd?.toFixed(4)}`);
  console.log(`  → result: ${r1.result?.slice(0, 100)}`);
  if (!r1.ok) console.log(`  → error: ${r1.error}`);
  console.log();

  // 테스트 2: Sonnet + JSON Schema
  console.log('[2/5] Claude Code OAuth — sonnet + JSON Schema');
  const r2 = await callClaudeCodeOAuth({
    prompt: '인천의 인구와 면적은?',
    model: 'sonnet',
    jsonSchema: {
      type: 'object',
      properties: { population: { type: 'integer' }, area_km2: { type: 'number' } },
      required: ['population', 'area_km2'],
    },
    timeoutMs: 30_000,
  });
  console.log(`  → ok=${r2.ok}, ${r2.durationMs}ms, $${r2.totalCostUsd?.toFixed(4)}`);
  console.log(`  → structured: ${JSON.stringify(r2.structuredOutput)}`);
  if (!r2.ok) console.log(`  → error: ${r2.error}`);
  console.log();

  // 테스트 3: Groq 8B (fast)
  console.log('[3/5] Groq — llama-3.1-8b-instant');
  const r3 = await callGroqFallback({ prompt: '한국의 수도는? 한 단어로.', model: 'llama-3.1-8b-instant' });
  console.log(`  → ok=${r3.ok}, ${r3.durationMs}ms, est $${r3.totalCostUsd?.toFixed(6)}`);
  console.log(`  → result: ${r3.result?.slice(0, 100)}`);
  if (!r3.ok) console.log(`  → error: ${r3.error}`);
  console.log();

  // 테스트 4: Groq 70B (standard)
  console.log('[4/5] Groq — llama-3.3-70b-versatile');
  const r4 = await callGroqFallback({ prompt: '인천의 인구를 숫자만. 예: 2990000', model: 'llama-3.3-70b-versatile' });
  console.log(`  → ok=${r4.ok}, ${r4.durationMs}ms, est $${r4.totalCostUsd?.toFixed(6)}`);
  console.log(`  → result: ${r4.result?.slice(0, 100)}`);
  if (!r4.ok) console.log(`  → error: ${r4.error}`);
  console.log();

  // 테스트 5: 통합 체인 (Primary → Fallback)
  console.log('[5/5] callWithFallback — anthropic_haiku (전체 체인)');
  const r5 = await callWithFallback({ prompt: '1 + 1 = ?', abstractModel: 'anthropic_haiku', timeoutMs: 30_000 });
  console.log(`  → provider=${r5.provider}, ok=${r5.ok}, ${r5.durationMs}ms`);
  console.log(`  → result: ${r5.result?.slice(0, 100)}`);
  if (r5.primaryError) console.log(`  → primaryError: ${r5.primaryError}`);
  console.log();

  console.log('✅ 테스트 완료');
}

main().catch((err) => {
  console.error('❌ 테스트 실패:', err);
  process.exit(1);
});
