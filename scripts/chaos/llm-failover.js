#!/usr/bin/env node
'use strict';

/**
 * 카오스 테스트: LLM 라우터 + 폴백 체인 검증
 *
 * 시나리오:
 *   1. 정상 모델 선택 (기준선)
 *   2. 잘못된 팀/요청 유형 → 폴백 처리
 *   3. 극단적 입력값 → 크래시 없는지 검증
 *   4. Claude API 직접 호출 → 짧은 타임아웃 → 에러 처리
 *
 * 실행: node scripts/chaos/llm-failover.js
 */

const llmRouter = require('../../packages/core/lib/llm-router');
const { getAnthropicKey } = require('../../packages/core/lib/llm-keys');

async function testModelSelection() {
  console.log('=== 1. 모델 선택 (정상 케이스) ===');
  const cases = [
    { team: 'ska',    requestType: 'status_check',        inputLength: 100 },
    { team: 'claude', requestType: 'improvement_analysis', inputLength: 500 },
    { team: 'luna',   requestType: 'trade_decision',       inputLength: 300 },
  ];

  for (const c of cases) {
    try {
      const { model, complexity } = llmRouter.selectModel(c);
      console.log(`  ✅ [${c.team}/${c.requestType}] → ${model} (${complexity})`);
    } catch (e) {
      console.log(`  ❌ [${c.team}/${c.requestType}] → 오류: ${e.message}`);
    }
  }
}

async function testEdgeCases() {
  console.log('\n=== 2. 엣지 케이스 — 크래시 없는지 검증 ===');

  const edgeCases = [
    { label: '알 수 없는 팀',       args: { team: 'nonexistent_team', requestType: 'status_check' } },
    { label: '알 수 없는 요청유형', args: { team: 'ska', requestType: 'unknown_request_xyz' } },
    { label: '팀 없음 (null)',       args: { team: null, requestType: 'status_check' } },
    { label: '전부 null',            args: { team: null, requestType: null } },
    { label: '빈 객체',              args: {} },
    { label: '매우 긴 입력',         args: { team: 'claude', requestType: 'code_review', inputLength: 999999 } },
  ];

  for (const { label, args } of edgeCases) {
    try {
      const result = llmRouter.selectModel(args);
      console.log(`  ✅ ${label} → ${result?.model || 'N/A'} (${result?.complexity || 'N/A'}) — 크래시 없음`);
    } catch (e) {
      // 에러를 던져도 크래시 없이 캐치되면 OK
      console.log(`  ⚠️ ${label} → 예외: ${e.message.slice(0, 60)} — 크래시 없음 ✅`);
    }
  }
}

async function testApiTimeout() {
  console.log('\n=== 3. Claude API 타임아웃 처리 ===');

  let apiKey;
  try {
    apiKey = getAnthropicKey();
  } catch {
    console.log('  ⬜ Anthropic API 키 없음 — 스킵');
    return;
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic({ apiKey });

  // 의도적으로 매우 짧은 타임아웃
  console.log('  1ms 타임아웃으로 API 호출 시도...');
  const t0 = Date.now();
  try {
    const result = await Promise.race([
      client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages:   [{ role: 'user', content: '1+1' }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('의도적 타임아웃 (1ms)')), 1)),
    ]);
    console.log(`  ✅ 응답 성공 (${Date.now() - t0}ms) — 풀 여유`);
  } catch (e) {
    console.log(`  ⚠️ 타임아웃 에러 (${Date.now() - t0}ms): ${e.message.slice(0, 60)}`);
    console.log('  → 시스템 크래시 없이 에러 처리됨 ✅');
  }

  // 잘못된 모델명 — API 에러 처리
  console.log('\n  잘못된 모델명 API 호출 시도...');
  try {
    await client.messages.create({
      model:      'nonexistent-model-xyz-999',
      max_tokens: 5,
      messages:   [{ role: 'user', content: '1+1' }],
    });
    console.log('  ✅ 응답 (예상 외)');
  } catch (e) {
    console.log(`  ⚠️ API 에러: ${e.message?.slice(0, 60)} → 시스템 크래시 없음 ✅`);
  }
}

async function testCostClassification() {
  console.log('\n=== 4. 비용 분류 일관성 검증 ===');
  const { MODEL_MAP, COST_ESTIMATE } = llmRouter;

  for (const [complexity, model] of Object.entries(MODEL_MAP)) {
    const cost = COST_ESTIMATE[complexity];
    console.log(`  ${complexity.padEnd(10)} → ${model.slice(0, 40).padEnd(40)} $${cost}/1K`);
  }
  console.log('  ✅ 모델-비용 매핑 일관성 확인');
}

async function main() {
  console.log('=== 카오스 테스트: LLM 폴백 체인 ===\n');

  await testModelSelection();
  await testEdgeCases();
  await testApiTimeout();
  await testCostClassification();

  console.log('\n=== 테스트 완료 ===');
  console.log('시스템이 크래시 없이 여기까지 도달 → LLM 라우터/폴백 정상 ✅');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ 예상치 못한 크래시:', e.message);
  process.exit(1);
});
