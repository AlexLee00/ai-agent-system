#!/usr/bin/env node
'use strict';

// 품질 검사 통합 리포트 — 리뷰어+가디언+빌더 결과를 1건으로 묶어 발송

const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const kst = require('../../../packages/core/lib/kst');
const reviewer = require('./reviewer');
const guardian = require('./guardian');
const builder = require('./builder');

function formatCombinedReport(results) {
  const lines = [
    `📋 클로드팀 품질 리포트 (${kst.datetimeStr()})`,
    '',
  ];

  // 리뷰어
  const rev = results.reviewer;
  if (rev.skipped) {
    lines.push('📝 코드 리뷰: 스킵 (JS 변경 없음)');
  } else if (rev.summary.pass) {
    lines.push(`📝 코드 리뷰: ✅ 통과 (${rev.summary.totalFiles}개 파일)`);
  } else {
    lines.push(`📝 코드 리뷰: ⚠️ 이슈 ${rev.summary.critical + rev.summary.high}건`);
    if (rev.summary.syntaxFails > 0) lines.push(`  - 문법 실패: ${rev.summary.syntaxFails}건`);
    if (rev.summary.critical > 0) lines.push(`  - CRITICAL: ${rev.summary.critical}건`);
    if (rev.summary.high > 0) lines.push(`  - HIGH: ${rev.summary.high}건`);
  }

  // 가디언
  const grd = results.guardian;
  if (grd.pass) {
    lines.push(`🛡️ 보안 검사: ✅ 이상 없음 (${grd.files.length}개 파일)`);
  } else {
    lines.push(`🛡️ 보안 검사: ⚠️ 이슈 ${grd.critical.length + grd.high.length}건`);
    if (grd.critical.length > 0) lines.push(`  - CRITICAL: ${grd.critical.length}건`);
    if (grd.high.length > 0) lines.push(`  - HIGH: ${grd.high.length}건`);
  }

  // 빌더
  const bld = results.builder;
  if (bld.skipped) {
    lines.push('🔨 빌드 검증: 스킵 (빌드 대상 변경 없음)');
  } else if (bld.pass) {
    lines.push(`🔨 빌드 검증: ✅ 통과 (${bld.project})`);
  } else {
    lines.push(`🔨 빌드 검증: ❌ 실패 (${bld.project})`);
  }

  // 종합
  const allPass = (rev.skipped || rev.summary.pass) && grd.pass && (bld.skipped || bld.pass);
  lines.push('');
  lines.push(allPass ? '✅ 종합: 통과' : '⚠️ 종합: 이슈 있음 — 확인 필요');

  return lines.join('\n');
}

async function run() {
  const testMode = process.argv.includes('--test');

  // 3개 봇을 test 모드(발송 안 함)로 실행
  const [revResult, grdResult, bldResult] = await Promise.all([
    reviewer.runReview({ test: true }),
    guardian.runSecurityCheck({ test: true }),
    builder.runBuildCheck({ test: true }),
  ]);

  const results = {
    reviewer: { ...revResult, summary: revResult.summary || {} },
    guardian: grdResult,
    builder: bldResult,
  };

  const message = formatCombinedReport(results);
  let sent = false;

  if (!testMode) {
    const hasCritical = (grdResult.critical || []).length > 0
      || (revResult.summary?.critical || 0) > 0;
    sent = (await postAlarm({
      message,
      team: 'claude',
      alertLevel: hasCritical ? 4 : 2,
      fromBot: 'quality-report',
    })).ok;
  }

  console.log(message);
  const allPass = (revResult.skipped || revResult.summary?.pass)
    && grdResult.pass
    && (bldResult.skipped || bldResult.pass);

  return { results, message, sent, pass: allPass };
}

module.exports = { run, formatCombinedReport };

if (require.main === module) {
  run()
    .then((result) => process.exit(result.pass ? 0 : 1))
    .catch((error) => {
      console.warn(`[quality-report] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
