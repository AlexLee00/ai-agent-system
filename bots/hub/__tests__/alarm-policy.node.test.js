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
