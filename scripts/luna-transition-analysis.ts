// @ts-nocheck
'use strict';

/**
 * scripts/luna-transition-analysis.js — 루나팀 Shadow → Confirmation 전환 판단
 *
 * shadow_log에서 luna팀의 일치율을 분석하여 전환 가능 여부를 판단.
 * 결과를 콘솔 출력 + 텔레그램 📌 총괄 Topic에 발송.
 *
 * 사용법:
 *   node scripts/luna-transition-analysis.js             # 콘솔 출력
 *   node scripts/luna-transition-analysis.js --telegram  # 텔레그램 발송
 */

const path   = require('path');
const ROOT   = path.join(__dirname, '..');
const shadow = require(path.join(ROOT, 'packages/core/lib/shadow-mode'));
const hubAlarmClient = require(path.join(ROOT, 'packages/core/lib/hub-alarm-client'));

const SEND_TG = process.argv.includes('--telegram');

// ── 전환 판단 기준 ────────────────────────────────────────────────────
const READY_THRESHOLD  = 0.90;  // 90%+  → READY
const TUNING_THRESHOLD = 0.80;  // 80%+  → TUNING
const MIN_SAMPLES      = 10;    // 최소 샘플 수

async function analyzeLunaTransition() {
  // 기간별 일치율
  const [allTime, recent7, recent3] = await Promise.all([
    shadow.getMatchRate('luna', null, 30),
    shadow.getMatchRate('luna', null, 7),
    shadow.getMatchRate('luna', null, 3),
  ]);

  // 불일치 항목 분석 (최근 14일)
  const mismatches = await shadow.getMismatches('luna', null, 14);

  // 현재 모드 조회
  const currentMode = await shadow.getTeamMode('luna');

  // 전환 판단
  const rate7 = recent7.matchRate;
  let recommendation;
  if (rate7 === null || recent7.total < MIN_SAMPLES) {
    recommendation = '❓ DATA_INSUFFICIENT — 샘플 부족, 추가 관측 필요';
  } else if (rate7 >= READY_THRESHOLD) {
    recommendation = '✅ READY — 마스터 승인 후 confirmation 전환 가능';
  } else if (rate7 >= TUNING_THRESHOLD) {
    recommendation = '⚠️ TUNING — 프롬프트 튜닝 후 재검토 (목표 90%+)';
  } else {
    recommendation = '❌ HOLD — 기존 규칙엔진 유지, 추가 분석 필요';
  }

  const fmtRate = (r, n) =>
    r === null ? 'N/A' : `${(r * 100).toFixed(1)}% (${n}건)`;

  const mismatchLines = mismatches.slice(0, 3).map(m => {
    const rule = m.rule_result?.decision ?? '-';
    const llm  = m.llm_result?.decision  ?? '-';
    return `  • [${m.context ?? 'luna'}] 규칙=${rule} vs LLM=${llm}`;
  });

  const report = [
    '💰 루나팀 Shadow 전환 분석',
    '════════════════════════',
    `현재 모드: ${currentMode}`,
    '',
    `전체(30일): ${fmtRate(allTime.matchRate, allTime.total)}`,
    `최근  7일:  ${fmtRate(recent7.matchRate, recent7.total)}`,
    `최근  3일:  ${fmtRate(recent3.matchRate, recent3.total)}`,
    '',
    `불일치 ${mismatches.length}건 (최근 14일)`,
    ...(mismatchLines.length > 0 ? mismatchLines : ['  (없음)']),
    '',
    `📋 판단: ${recommendation}`,
    '',
    '⚠️ 전환은 반드시 마스터 승인 후!',
    '/luna_confirm — confirmation 모드 전환',
    '/luna_shadow  — shadow 모드로 복귀',
  ].join('\n');

  return { report, recommendation, currentMode, recent7 };
}

async function main() {
  console.log('🔍 루나팀 전환 분석 중...\n');

  const { report, recommendation, currentMode, recent7 } = await analyzeLunaTransition();
  console.log(report);

  if (SEND_TG) {
    const result = await hubAlarmClient.postAlarm({
      team: 'general',
      message: report,
      alertLevel: 1,
      fromBot: 'luna-transition-analysis',
    });
    const ok = Boolean(result?.ok);
    console.log(`\n텔레그램 발송: ${ok ? '✅' : '❌'}`);
  }

  process.exit(0);
}

main().catch(e => { console.error('❌:', e.message); process.exit(1); });
