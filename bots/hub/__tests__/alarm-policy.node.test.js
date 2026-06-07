'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '..', 'lib', 'alarm', 'policy.ts')
).href;

async function loadModule() {
  const mod = await import(moduleUrl);
  return mod.default || mod;
}

test('downgrades reservation booking detection to report', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'error',
    eventType: 'alert',
    title: 'reservation alarm',
    message: '🆕 신규 예약 감지\n✅ 조치: Pickko 자동 등록 준비 중...',
  });

  assert.deepEqual(result, { type: 'report', confidence: 0.97 });
});

test('downgrades investment position watch snapshot to report', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'error',
    eventType: 'alert',
    title: 'investment alarm',
    message: '👀 포지션 watch\nstatus: position_runtime_attention\nautopilot: position_runtime_autopilot_ready',
  });

  assert.deepEqual(result, { type: 'report', confidence: 0.95 });
});

test('treats auto-dev self stage snapshot as work', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'error',
    eventType: 'auto_dev_stage_failed',
    title: 'claude alarm',
    message: '🤖 클로드팀 auto_dev\nstage failed',
  });

  assert.deepEqual(result, { type: 'work', confidence: 0.98 });
});

test('downgrades blog instagram publish success snapshot to report', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'warn',
    eventType: 'unknown_error',
    title: 'blog alarm',
    message: '✅ [블로팀] 인스타 발행 성공\n글: 테스트 글\npublishId: 1234567890',
  });

  assert.deepEqual(result, { type: 'report', confidence: 0.94 });
});

test('downgrades blog weekly evolution completion to report', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'info',
    eventType: 'blog_weekly_evolution',
    title: 'blog alarm',
    message: '블로그팀 주간 전략 진화 완료\n14건 분석 / 약점: title_pattern_bias\nweekly-evolution 완료',
  });

  assert.deepEqual(result, { type: 'report', confidence: 0.96 });
});

test('downgrades darwin weekly research snapshot even when legacy event says error', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'info',
    eventType: 'research-scanner_error',
    title: 'general alarm',
    message: '🔬 다윈팀 주간 리서치 (2026-05-19)\n수집: 131건 | 평가: 40건 | 저장: 40건\n\n⭐ 적합성 7점+ 논문 2건:',
  });

  assert.equal(result.type, 'report');
  assert.ok(result.confidence >= 0.8);
});

test('downgrades steward daily summary even when legacy event says error', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'info',
    eventType: 'steward_error',
    title: 'general alarm',
    message: '📋 스튜어드 일일 요약 (2026-06-07)\n\n⚠️ git 위생: 의심 파일 1건\n✅ 텔레그램: 전체 토픽 정상',
  });

  assert.deepEqual(result, { type: 'report', confidence: 0.97 });
});

test('keeps actionable runtime failure as error', async () => {
  const { classifyAlarmTypeWithConfidence } = await loadModule();
  const result = classifyAlarmTypeWithConfidence({
    severity: 'error',
    eventType: 'blog-commenter_error',
    title: 'blog alarm',
    message: 'reply_process_timeout:240000\n실패 2건',
  });

  assert.equal(result.type, 'error');
  assert.ok(result.confidence >= 0.8);
});
