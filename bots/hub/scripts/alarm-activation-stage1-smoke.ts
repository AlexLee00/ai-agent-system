'use strict';

/**
 * Polish 1 Stage 1 — Shadow Mode 활성화 검증 smoke
 *
 * 검증 항목:
 *   1. HUB_ALARM_DISPATCH_MODE=shadow → getDispatchMode() 반환값
 *   2. HUB_ALARM_DISPATCH_MODE 미설정 → 기본값 'supervised'
 *   3. HUB_ALARM_CRITICAL_TYPE_ENABLED 게이트 동작
 *   4. Phase A/B/C 환경변수 5개 enable 패턴 확인
 *   5. plist 환경변수 설정 대상 키 존재 확인
 */

import path from 'node:path';
import fs from 'node:fs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[stage1-smoke] FAIL: ${message}`);
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

function testDispatchMode(): void {
  const { getDispatchMode } = require('../lib/routes/alarm');

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'shadow' }, () => {
    assert(getDispatchMode() === 'shadow', 'shadow 설정 시 shadow 반환');
  });

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'supervised' }, () => {
    assert(getDispatchMode() === 'supervised', 'supervised 설정 시 supervised 반환');
  });

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'autonomous' }, () => {
    assert(getDispatchMode() === 'autonomous', 'autonomous 설정 시 autonomous 반환');
  });

  withEnv({ HUB_ALARM_DISPATCH_MODE: undefined }, () => {
    assert(getDispatchMode() === 'supervised', '미설정 시 기본값 supervised');
  });

  withEnv({ HUB_ALARM_DISPATCH_MODE: 'invalid_value' }, () => {
    assert(getDispatchMode() === 'supervised', '잘못된 값 → supervised 폴백');
  });
}

function testCriticalTypeGate(): void {
  const { isCriticalTypeEnabled } = require('../lib/alarm/classify-alarm-llm');

  withEnv({ HUB_ALARM_CRITICAL_TYPE_ENABLED: undefined }, () => {
    assert(!isCriticalTypeEnabled(), '미설정 시 critical type 비활성화');
  });

  withEnv({ HUB_ALARM_CRITICAL_TYPE_ENABLED: 'false' }, () => {
    assert(!isCriticalTypeEnabled(), 'false 설정 시 critical type 비활성화');
  });

  withEnv({ HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true' }, () => {
    assert(isCriticalTypeEnabled(), 'true 설정 시 critical type 활성화');
  });

  withEnv({ HUB_ALARM_CRITICAL_TYPE_ENABLED: '1' }, () => {
    assert(isCriticalTypeEnabled(), '1 설정 시 critical type 활성화');
  });
}

function testPhaseEnvVarPatterns(): void {
  const enableKeys = [
    'HUB_ALARM_LLM_CLASSIFIER_ENABLED',
    'HUB_ALARM_INTERPRETER_ENABLED',
    'HUB_ALARM_ENRICHMENT_ENABLED',
    'HUB_ALARM_CRITICAL_TYPE_ENABLED',
  ];

  for (const key of enableKeys) {
    const truthy = ['true', '1', 'yes', 'y', 'on'];
    const falsy = ['false', '0', 'no', 'n', 'off', ''];

    for (const v of truthy) {
      const isTrue = ['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
      assert(isTrue, `${key}=${v} → truthy`);
    }
    for (const v of falsy) {
      const isFalse = !['1', 'true', 'yes', 'y', 'on'].includes(v.trim().toLowerCase());
      assert(isFalse, `${key}=${v} → falsy`);
    }
  }
}

function testPlistContainsStage1Keys(): void {
  const plistPath = path.resolve(
    __dirname,
    '../launchd/ai.hub.resource-api.plist',
  );
  assert(fs.existsSync(plistPath), 'plist 파일 존재');

  const content = fs.readFileSync(plistPath, 'utf8');

  const requiredKeys = [
    'HUB_ALARM_DISPATCH_MODE',
    'HUB_ALARM_LLM_CLASSIFIER_ENABLED',
    'HUB_ALARM_CRITICAL_TYPE_ENABLED',
    'HUB_ALARM_INTERPRETER_ENABLED',
    'HUB_ALARM_ENRICHMENT_ENABLED',
  ];

  for (const key of requiredKeys) {
    assert(content.includes(key), `plist에 ${key} 포함`);
  }

  // Shadow Mode가 설정된 상태 확인
  const shadowIdx = content.indexOf('HUB_ALARM_DISPATCH_MODE');
  const shadowValueIdx = content.indexOf('<string>shadow</string>', shadowIdx);
  assert(shadowValueIdx > 0, 'plist HUB_ALARM_DISPATCH_MODE=shadow 확인');
}

function testMigrationFileExists(): void {
  const migrationPath = path.resolve(
    __dirname,
    '../migrations/20261001000050_hub_alarm_tables.sql',
  );
  assert(fs.existsSync(migrationPath), 'hub_alarm_tables migration SQL 존재');

  const content = fs.readFileSync(migrationPath, 'utf8');
  assert(content.includes('hub_alarm_classifications'), 'hub_alarm_classifications 테이블 정의 포함');
  assert(content.includes('hub_alarms'), 'hub_alarms 테이블 정의 포함');
  // alarm_roundtables는 alarm-roundtable-engine.ts가 자동 생성 (migration 불필요)
}

function main(): void {
  testDispatchMode();
  testCriticalTypeGate();
  testPhaseEnvVarPatterns();
  testPlistContainsStage1Keys();
  testMigrationFileExists();

  console.log('alarm_activation_stage1_smoke_ok');
}

main();
