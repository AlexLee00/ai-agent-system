'use strict';

/**
 * daemon.js — 저스틴팀 상시 감정 데몬 (15분 주기)
 *
 * 역할:
 *   1. 활성 사건의 SLA 위반 탐지
 *   2. 위반 사건 텔레그램 리마인더 발송
 *
 * SLA 기준 (상태별 최대 대기 시간):
 *   received        → 24시간 이내 분석 착수
 *   analyzing       → 48시간 이내 완료
 *   questioning1    → 7일 이내 응답 수신
 *   interview1      → 3일 이내 인터뷰 완료
 *   questioning2    → 7일 이내 응답 수신
 *   interview2      → 3일 이내 인터뷰 완료
 *   inspection_plan → 3일 이내 현장실사 착수
 *   inspecting      → 5일 이내 완료
 *   drafting        → 5일 이내 완료
 *   reviewing       → 2일 이내 승인
 */

const path = require('path');
const env = require('../../../packages/core/lib/env');
const store = require(path.join(env.PROJECT_ROOT, 'bots/legal/lib/appraisal-store'));

const SLA_HOURS = {
  received:        24,
  analyzing:       48,
  questioning1:    7 * 24,
  interview1:      3 * 24,
  questioning2:    7 * 24,
  interview2:      3 * 24,
  inspection_plan: 3 * 24,
  inspecting:      5 * 24,
  drafting:        5 * 24,
  reviewing:       2 * 24,
};

const TERMINAL_STATUSES = new Set(['completed', 'submitted']);

function hoursSince(dateStr) {
  if (!dateStr) return 0;
  const diff = Date.now() - new Date(dateStr).getTime();
  return diff / (1000 * 60 * 60);
}

function buildAlertMsg(violations) {
  const lines = ['⚠️ [저스틴팀] SLA 위반 감지'];
  for (const v of violations) {
    lines.push(`  • ${v.case_number} — ${v.status} (${Math.round(v.elapsed_hours)}h 경과, SLA ${v.sla_hours}h)`);
  }
  lines.push('\n마스터 확인 필요: node scripts/start-appraisal.js --list');
  return lines.join('\n');
}

async function run() {
  console.log(`[저스틴데몬] ${new Date().toISOString()} 시작`);

  let cases;
  try {
    cases = await store.listCases();
  } catch (err) {
    console.error('[저스틴데몬] DB 연결 실패:', err.message);
    process.exit(1);
  }

  const activeCases = cases.filter(c => !TERMINAL_STATUSES.has(c.status));
  console.log(`[저스틴데몬] 활성 사건 ${activeCases.length}건 점검`);

  const violations = [];
  for (const c of activeCases) {
    const slaHours = SLA_HOURS[c.status];
    if (!slaHours) continue;
    const elapsed = hoursSince(c.updated_at || c.created_at);
    if (elapsed > slaHours) {
      violations.push({
        case_number: c.case_number,
        status: c.status,
        elapsed_hours: elapsed,
        sla_hours: slaHours,
      });
    }
  }

  if (violations.length === 0) {
    console.log('[저스틴데몬] SLA 위반 없음. 정상.');
    return;
  }

  console.log(`[저스틴데몬] SLA 위반 ${violations.length}건 발견`);
  violations.forEach(v =>
    console.log(`  - ${v.case_number}: ${v.status} ${Math.round(v.elapsed_hours)}h/${v.sla_hours}h`)
  );

  try {
    const sender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
    await sender.send('legal', buildAlertMsg(violations));
    console.log('[저스틴데몬] 텔레그램 알림 발송 완료');
  } catch (teleErr) {
    console.warn('[저스틴데몬] 텔레그램 발송 실패 (비치명적):', teleErr.message);
  }
}

run().catch(err => {
  console.error('[저스틴데몬] 예외:', err.message);
  process.exit(1);
});
