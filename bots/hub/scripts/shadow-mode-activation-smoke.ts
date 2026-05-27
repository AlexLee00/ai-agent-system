// @ts-nocheck
'use strict';

// Week 2 Day 8-9: Shadow Mode 활성화 검증 스크립트
// 환경변수 설정 확인 + DB 쓰기 + Shadow Mode 영향 X 검증
//
// 실행:
//   tsx bots/hub/scripts/shadow-mode-activation-smoke.ts
//   tsx bots/hub/scripts/shadow-mode-activation-smoke.ts --write

import path from 'node:path';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface SmokeResult {
  ok: boolean;
  ts: string;
  checks: Record<string, { ok: boolean; value?: string; message: string }>;
  dbWrite?: { ok: boolean; rowId?: number; message: string };
  shadowSafe: boolean;
  summary: string;
}

async function checkEnvVar(name: string, expected?: string): Promise<{ ok: boolean; value?: string; message: string }> {
  const value = process.env[name];
  if (!value) return { ok: false, message: `${name} 미설정` };
  if (expected && value !== expected) return { ok: false, value, message: `${name}=${value} (기대값: ${expected})` };
  return { ok: true, value, message: `${name}=${value} ✅` };
}

async function testDbWrite(pgPool: any): Promise<{ ok: boolean; rowId?: number; message: string }> {
  try {
    const result = await pgPool.query('public', `
      INSERT INTO hub.llm_auto_routing_log
        (agent, caller_team, task_type, task_complexity, auto_model, mode, model_overridden)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, ['shadow-smoke-test', 'system', 'smoke', 'simple', 'anthropic_haiku', 'shadow', false]);
    const rowId = result?.[0]?.id || result?.rows?.[0]?.id;
    return { ok: true, rowId, message: `DB 쓰기 성공 (id=${rowId}) ✅` };
  } catch (err: any) {
    return { ok: false, message: `DB 쓰기 실패: ${err?.message || err}` };
  }
}

export async function runShadowModeActivationSmoke(options: { write?: boolean } = {}): Promise<SmokeResult> {
  const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));

  const envChecks = await Promise.all([
    checkEnvVar('LLM_AUTO_ROUTING_ENABLED'),
    checkEnvVar('PERMISSION_TIER_ENFORCE'),
    checkEnvVar('HUB_BUDGET_GUARDIAN_ENABLED'),
  ]);

  const checks = {
    LLM_AUTO_ROUTING_ENABLED: envChecks[0],
    PERMISSION_TIER_ENFORCE: envChecks[1],
    HUB_BUDGET_GUARDIAN_ENABLED: envChecks[2],
  };

  const requiredShadowOk =
    checks.LLM_AUTO_ROUTING_ENABLED.value === 'shadow'
    && checks.PERMISSION_TIER_ENFORCE.value === 'shadow';
  const allEnvOk = Object.values(checks).every((c) => c.ok) && requiredShadowOk;

  let dbWrite: { ok: boolean; rowId?: number; message: string } | undefined;
  if (options.write || hasFlag('write')) {
    dbWrite = await testDbWrite(pgPool);
  }

  // Shadow Safe 검증: active 모드가 아니면 live trade 영향 없음
  const routingMode = process.env.LLM_AUTO_ROUTING_ENABLED || 'disabled';
  const permMode = process.env.PERMISSION_TIER_ENFORCE || 'disabled';
  const shadowSafe = routingMode !== 'active' && permMode !== 'active';

  const ok = allEnvOk && shadowSafe && (!dbWrite || dbWrite.ok);

  const lines = [
    `LLM_AUTO_ROUTING_ENABLED: ${checks.LLM_AUTO_ROUTING_ENABLED.message}`,
    `PERMISSION_TIER_ENFORCE: ${checks.PERMISSION_TIER_ENFORCE.message}`,
    `HUB_BUDGET_GUARDIAN_ENABLED: ${checks.HUB_BUDGET_GUARDIAN_ENABLED.message}`,
    `Shadow Safe: ${shadowSafe ? '✅ (live trade 영향 없음)' : '⚠️ active 모드 - 검토 필요!'}`,
    dbWrite ? `DB 쓰기: ${dbWrite.message}` : 'DB 쓰기: 건너뜀 (--write 없음)',
  ];

  return {
    ok,
    ts: new Date().toISOString(),
    checks,
    dbWrite,
    shadowSafe,
    summary: lines.join('\n'),
  };
}

async function main() {
  console.log('[shadow-mode-activation-smoke] Shadow Mode 활성화 검증 시작...');
  const result = await runShadowModeActivationSmoke({ write: hasFlag('write') });
  console.log('[shadow-mode-activation-smoke] 결과:');
  console.log(result.summary);
  if (!result.ok) {
    console.warn('\n[shadow-mode-activation-smoke] ⚠️ 일부 설정 미완료. 마스터 확인 필요!');
    console.warn('설정 방법:');
    console.warn('  launchctl setenv LLM_AUTO_ROUTING_ENABLED shadow');
    console.warn('  launchctl setenv PERMISSION_TIER_ENFORCE shadow');
    console.warn('  launchctl kickstart -k gui/$(id -u)/ai.hub.resource-api');
  } else {
    console.log('\n[shadow-mode-activation-smoke] ✅ Shadow Mode 준비 완료!');
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[shadow-mode-activation-smoke] 오류:', err?.message || err);
    process.exit(1);
  });
}
