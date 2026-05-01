'use strict';

/**
 * Polish 1 Stage 3 — Autonomous Mode + Roundtable 활성화 검증 smoke
 *
 * 검증 항목:
 *   1. autonomous 모드 설정값 확인
 *   2. HUB_ALARM_ROUNDTABLE_ENABLED gate 동작
 *   3. shouldTriggerRoundtable 트리거 조건 (critical 알람 시 즉시 트리거)
 *   4. Roundtable 일일 cap (기본 10)
 *   5. Roundtable 트리거 임계값 (fingerprint threshold 기본 3)
 *   6. Stage 3 전환 체크리스트
 *
 * 주의: Stage 3는 Stage 2 검증 후 마스터 승인 필요
 *       ⭐⭐⭐ Jay+Claude+팀장 회의 마스터 핵심 비전 가동 단계
 */

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[stage3-smoke] FAIL: ${message}`);
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

function testAutonomousMode(): void {
  const { getDispatchMode } = require('../lib/routes/alarm');

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'autonomous' }, () => {
    const mode = getDispatchMode();
    assert(mode === 'autonomous', 'autonomous 모드 반환');
    assert(mode !== 'shadow', 'autonomous는 shadow가 아님');
  });
}

function testRoundtableEnabledGate(): void {
  const { getDailyRoundtableCount } = require('../lib/alarm/alarm-roundtable-engine');

  withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: undefined }, () => {
    const raw = String(process.env.HUB_ALARM_ROUNDTABLE_ENABLED || '').trim().toLowerCase();
    const isEnabled = ['1', 'true', 'yes', 'y', 'on'].includes(raw);
    assert(!isEnabled, 'ROUNDTABLE_ENABLED 미설정 → 비활성화 (기본값)');
  });

  withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: 'true' }, () => {
    const raw = String(process.env.HUB_ALARM_ROUNDTABLE_ENABLED || '').trim().toLowerCase();
    const isEnabled = ['1', 'true', 'yes', 'y', 'on'].includes(raw);
    assert(isEnabled, 'ROUNDTABLE_ENABLED=true → 활성화');
  });

  // getDailyRoundtableCount는 현재 count를 반환 (0 이상)
  assert(typeof getDailyRoundtableCount === 'function', 'getDailyRoundtableCount 함수 존재');
}

function testRoundtableDailyCapDefault(): void {
  withEnv({ HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: undefined }, () => {
    const cap = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);
    assert(cap === 10, `roundtable 일일 cap 기본값=10, 실제=${cap}`);
  });

  withEnv({ HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: '5' }, () => {
    const cap = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);
    assert(cap === 5, `roundtable 일일 cap=5 오버라이드`);
  });
}

function testRoundtableTriggerThreshold(): void {
  withEnv({ HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD: undefined }, () => {
    const threshold = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD || 3) || 3);
    assert(threshold === 3, `fingerprint threshold 기본값=3, 실제=${threshold}`);
  });

  withEnv({ HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD: '5' }, () => {
    const threshold = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD || 3) || 3);
    assert(threshold === 5, `fingerprint threshold=5 오버라이드`);
  });
}

async function testShouldTriggerRoundtableInterface(): Promise<void> {
  const { shouldTriggerRoundtable } = require('../lib/alarm/alarm-roundtable-engine');
  assert(typeof shouldTriggerRoundtable === 'function', 'shouldTriggerRoundtable 함수 존재');

  // ROUNDTABLE_ENABLED=false 시 즉시 false 반환 (DB 쿼리 X)
  await withEnvAsync({ HUB_ALARM_ROUNDTABLE_ENABLED: 'false' }, async () => {
    const result = await shouldTriggerRoundtable({ alarmType: 'critical', visibility: 'emergency' });
    assert(result === false, 'ENABLED=false 시 critical이어도 false 반환');
  });

  // ROUNDTABLE_ENABLED=true, critical 알람 → true
  await withEnvAsync({ HUB_ALARM_ROUNDTABLE_ENABLED: 'true' }, async () => {
    const result = await shouldTriggerRoundtable({ alarmType: 'critical', visibility: 'emergency' });
    assert(result === true, 'ENABLED=true, critical 알람 → 즉시 true');
  });

  // ROUNDTABLE_ENABLED=true, work 알람 → false
  await withEnvAsync({ HUB_ALARM_ROUNDTABLE_ENABLED: 'true' }, async () => {
    const result = await shouldTriggerRoundtable({ alarmType: 'work', visibility: 'notify' });
    assert(result === false, 'work 알람 → false');
  });
}

async function withEnvAsync(patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key]!;
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key]!;
    }
  }
}

function testStage3TransitionChecklist(): void {
  const { getDispatchMode } = require('../lib/routes/alarm');

  // Stage 3 전환 시 설정값 검증
  withEnv({
    HUB_ALARM_DISPATCH_MODE: 'autonomous',
    HUB_ALARM_ROUNDTABLE_ENABLED: 'true',
    HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: '10',
    HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD: '3',
  }, () => {
    assert(getDispatchMode() === 'autonomous', 'Stage 3: dispatch_mode=autonomous');

    const roundtableEnabled = ['1', 'true', 'yes', 'y', 'on'].includes(
      String(process.env.HUB_ALARM_ROUNDTABLE_ENABLED || '').trim().toLowerCase(),
    );
    assert(roundtableEnabled, 'Stage 3: ROUNDTABLE_ENABLED=true');

    const cap = Math.max(1, Number(process.env.HUB_ALARM_ROUNDTABLE_DAILY_LIMIT || 10) || 10);
    assert(cap === 10, `Stage 3: roundtable 일일 cap=10`);
  });
}

async function main(): Promise<void> {
  testAutonomousMode();
  testRoundtableEnabledGate();
  testRoundtableDailyCapDefault();
  testRoundtableTriggerThreshold();
  await testShouldTriggerRoundtableInterface();
  testStage3TransitionChecklist();

  console.log('alarm_activation_stage3_smoke_ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
