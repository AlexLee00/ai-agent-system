// @ts-nocheck
'use strict';

// Langfuse 통합 smoke 테스트
// 사용: tsx bots/hub/scripts/langfuse-integration-smoke.ts

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

async function main() {
  const host = process.env.LANGFUSE_HOST || 'http://localhost:3000';
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || '';
  const secretKey = process.env.LANGFUSE_SECRET_KEY || '';

  console.log('[smoke] Langfuse 통합 테스트 시작');
  console.log(`[smoke] host: ${host}`);
  console.log(`[smoke] public_key: ${publicKey ? '***설정됨***' : '❌ 미설정'}`);
  console.log(`[smoke] secret_key: ${secretKey ? '***설정됨***' : '❌ 미설정'}`);

  if (!publicKey || !secretKey) {
    console.warn('[smoke] ⚠️  API 키 미설정 — Langfuse UI에서 발급 후 환경변수 설정 필요');
    console.warn('[smoke]   1. http://localhost:3000 접속');
    console.warn('[smoke]   2. 회원가입 → 프로젝트 생성');
    console.warn('[smoke]   3. Settings → API Keys → 발급');
    console.warn('[smoke]   4. secrets-store.json에 langfuse.public_key / langfuse.secret_key 입력');
    console.warn('[smoke]   5. launchd plist에 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 추가');
    process.exit(0);
  }

  // Langfuse 서버 연결 확인
  try {
    const resp = await fetch(`${host}/api/public/health`);
    if (resp.ok) {
      console.log('[smoke] ✅ Langfuse 서버 연결 성공');
    } else {
      console.warn('[smoke] ⚠️  Langfuse 서버 응답 이상:', resp.status);
    }
  } catch (e) {
    console.error('[smoke] ❌ Langfuse 서버 연결 실패:', e.message);
    console.error('[smoke]   → OPS에서 실행 중인지 확인하세요 (http://localhost:3000)');
    process.exit(1);
  }

  // trace 전송 테스트
  try {
    process.env.LANGFUSE_ENABLED = 'true';
    const { traceLLMCall } = require('../lib/langfuse-tracer');

    traceLLMCall(
      { prompt: 'smoke test prompt', systemPrompt: 'smoke test system' },
      { ok: true, provider: 'smoke-test', selected_route: 'smoke/test', durationMs: 42, totalCostUsd: 0.001 },
      { agent: 'smoke-tester', callerTeam: 'hub', taskType: 'smoke_test', abstractModel: 'anthropic_sonnet' },
    );

    // flush 대기
    const { flushLangfuse } = require('../lib/langfuse-tracer');
    await flushLangfuse();

    console.log('[smoke] ✅ trace 전송 완료 → Langfuse UI에서 확인하세요');
    console.log(`[smoke]   → ${host}/traces`);
  } catch (e) {
    console.error('[smoke] ❌ trace 전송 실패:', e.message);
    process.exit(1);
  }

  console.log('[smoke] ✅ Langfuse 통합 smoke 테스트 완료');
}

main().catch((e) => {
  console.error('[smoke] 치명적 오류:', e?.message || e);
  process.exit(1);
});
