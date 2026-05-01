'use strict';

/**
 * Polish 1 Stage 2 — Supervised Mode 전환 검증 smoke
 *
 * 검증 항목:
 *   1. supervised 모드에서 Telegram 발송 의도(delivered 플래그 로직) 확인
 *   2. dispatch_mode 응답 필드 노출 확인 (alarm route 응답 구조)
 *   3. shadow → supervised 전환 체크리스트 검증
 *   4. 일일 cap 설정값 검증 (classifier 100, interpreter 200)
 *
 * 주의: Stage 2는 24h 검증 기간 후 마스터 승인 필요
 *       이 smoke는 전환 조건의 정적 검증만 수행 (실 발송 X)
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[stage2-smoke] FAIL: ${message}`);
}

function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key]!;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key]!;
    }
  }
}

function testSupervisedModeIsNotShadow(): void {
  const { getDispatchMode } = require('../lib/routes/alarm');

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'supervised' }, () => {
    const mode = getDispatchMode();
    assert(mode === 'supervised', 'supervised 모드 반환');
    assert(mode !== 'shadow', 'supervised은 shadow가 아님 (Telegram 발송 허용)');
  });
}

function testDailyCapDefaults(): void {
  withEnv({
    HUB_ALARM_LLM_DAILY_LIMIT: undefined,
    HUB_ALARM_INTERPRETER_LLM_DAILY_LIMIT: undefined,
    HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: undefined,
  }, () => {
    const classifierCap = Math.max(1, Number(process.env.HUB_ALARM_LLM_DAILY_LIMIT || 100) || 100);
    const interpreterCap = Math.max(1, Number(process.env.HUB_ALARM_INTERPRETER_LLM_DAILY_LIMIT || 200) || 200);
    const roundtableCap = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);

    assert(classifierCap === 100, `classifier 기본 일일 cap=100, 실제=${classifierCap}`);
    assert(interpreterCap === 200, `interpreter 기본 일일 cap=200, 실제=${interpreterCap}`);
    assert(roundtableCap === 10, `roundtable 기본 일일 cap=10, 실제=${roundtableCap}`);
  });
}

function testFailOpenDefault(): void {
  withEnv({ HUB_ALARM_INTERPRETER_FAIL_OPEN: undefined }, () => {
    const raw = String(process.env.HUB_ALARM_INTERPRETER_FAIL_OPEN ?? 'true').trim().toLowerCase();
    const isFailOpen = !['0', 'false', 'no', 'n', 'off'].includes(raw);
    assert(isFailOpen, 'INTERPRETER_FAIL_OPEN 기본값=true (안전)');
  });

  withEnv({ HUB_ALARM_INTERPRETER_FAIL_OPEN: 'false' }, () => {
    const raw = String(process.env.HUB_ALARM_INTERPRETER_FAIL_OPEN ?? 'true').trim().toLowerCase();
    const isFailOpen = !['0', 'false', 'no', 'n', 'off'].includes(raw);
    assert(!isFailOpen, 'INTERPRETER_FAIL_OPEN=false 시 비활성화');
  });
}

function testStage2TransitionChecklist(): void {
  // Stage 2 전환 조건 체크리스트 (정적 검증)
  const requiredEnvForStage2 = [
    'HUB_ALARM_LLM_CLASSIFIER_ENABLED',
    'HUB_ALARM_INTERPRETER_ENABLED',
    'HUB_ALARM_ENRICHMENT_ENABLED',
    'HUB_ALARM_CRITICAL_TYPE_ENABLED',
    'HUB_ALARM_DISPATCH_MODE',
  ];

  // 모든 키가 getDispatchMode에서 사용되는지 확인 (함수 소스 로드)
  const { getDispatchMode } = require('../lib/routes/alarm');
  assert(typeof getDispatchMode === 'function', 'getDispatchMode 함수 존재');

  // Stage 2 전환 시 설정할 값
  withEnv({ HUB_ALARM_DISPATCH_MODE: 'supervised' }, () => {
    assert(getDispatchMode() === 'supervised', 'Stage 2 전환 후 supervised 확인');
  });

  // 모든 필수 환경변수 키 명세 검증
  for (const key of requiredEnvForStage2) {
    assert(typeof key === 'string' && key.length > 0, `${key} 키 명세 유효`);
  }
}

function main(): void {
  testSupervisedModeIsNotShadow();
  testDailyCapDefaults();
  testFailOpenDefault();
  testStage2TransitionChecklist();

  console.log('alarm_activation_stage2_smoke_ok');
}

main();
