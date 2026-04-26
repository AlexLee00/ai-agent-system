// @ts-nocheck
'use strict';

/**
 * scripts/run-graduation-analysis.js — LLM 졸업 후보 분석 실행
 *
 * 각 팀의 shadow_log에서 졸업 후보를 탐색하고 텔레그램으로 보고.
 * 마스터 승인 전 검토용 스크립트.
 *
 * 사용법:
 *   node scripts/run-graduation-analysis.js             # 콘솔 출력
 *   node scripts/run-graduation-analysis.js --telegram  # 텔레그램 발송
 */

const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const grad   = require(path.join(ROOT, 'packages/core/lib/llm-graduation'));
const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));

const SEND_TG = process.argv.includes('--telegram');
const TEAMS   = ['ska', 'claude-lead', 'luna'];

async function main() {
  console.log('🎓 LLM 졸업 후보 분석 중...\n');

  const allCandidates = [];

  for (const team of TEAMS) {
    const candidates = await grad.findGraduationCandidates(team, 20, 0.90);
    if (candidates.length > 0) {
      console.log(`[${team}] 졸업 후보 ${candidates.length}건:`);
      for (const c of candidates) {
        console.log(`  • [${c.context}] ${c.decision} — ${c.matchRate} (n=${c.total})`);
      }
    } else {
      console.log(`[${team}] 졸업 후보 없음`);
    }
    allCandidates.push(...candidates);
  }

  if (allCandidates.length === 0) {
    console.log('\n✅ 현재 졸업 후보가 없습니다. (샘플 부족 또는 일치율 미달)');
    process.exit(0);
  }

  console.log('\n── 팀별 상세 리포트 ──────────────────────────────');
  for (const team of TEAMS) {
    const report = await grad.buildGraduationReport(team);
    console.log('\n' + report);
  }

  const approvalGuide = [
    `🎓 LLM 졸업 후보 ${allCandidates.length}건 발견`,
    '⚠️ 마스터 승인 후에만 적용됩니다.',
    '',
    '승인 절차:',
    '1. /graduation_scan — 현재 후보 목록 확인',
    '2. /graduate_start <id> — 검증 시작 (2주 병렬 테스트)',
    '3. /graduate_approve <id> — 최종 승인 (규칙화)',
    '',
    '후보 목록:',
    ...allCandidates.slice(0, 5).map(c =>
      `  • [${c.team}/${c.context}] ${c.decision} — ${c.matchRate} (n=${c.total})`
    ),
    ...(allCandidates.length > 5 ? [`  ... 외 ${allCandidates.length - 5}건`] : []),
  ].join('\n');

  if (SEND_TG) {
    const ok = (await hubAlarmClient.postAlarm({
      team: 'claude-lead',
      message: approvalGuide,
      alertLevel: 2,
      fromBot: 'run-graduation-analysis',
    })).ok;
    console.log(`\n텔레그램 발송: ${ok ? '✅' : '❌'}`);
  } else {
    console.log('\n' + approvalGuide);
  }

  process.exit(0);
}

main().catch(e => { console.error('❌:', e.message); process.exit(1); });
