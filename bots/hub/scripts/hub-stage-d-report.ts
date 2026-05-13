// @ts-nocheck
/**
 * hub-stage-d-report.ts — Stage D Production Promotion Gate CLI
 *
 * npm run hub:stage-d-report
 * npm run hub:stage-d-report -- --write
 */

const path = require('node:path');
const {
  buildHubStageDProductionReport,
  writeHubStageDReport,
} = require('../lib/stage-d/production');

(async () => {
  const write = process.argv.includes('--write');
  console.log(`[stage-d] ${new Date().toISOString()} 보고서 생성 시작...`);

  const report = await buildHubStageDProductionReport();

  if (write) {
    const outputPath = await writeHubStageDReport(report);
    console.log(`[stage-d] 저장: ${outputPath}`);
  }

  const { goals, codeComplete, productionCertified, status } = report;
  console.log('\n=== Hub Stage D 보고 ===');
  console.log(`상태: ${status}`);
  console.log(`코드/게이트 완료: ${codeComplete ? '✅' : '🟡'}`);
  console.log(`Production 인증: ${productionCertified ? '✅' : '🟡 증거 누적 필요'}`);
  console.log('');
  console.log('목표별 상태:');
  for (const [key, ok] of Object.entries(goals)) {
    console.log(`  ${ok ? '✅' : '🟡'} ${key}`);
  }
  console.log('');

  if (productionCertified) {
    console.log('✅ Stage D Production 인증 완료.');
  } else if (codeComplete) {
    console.log('✅ Stage D 코드/게이트 완료. 7일 Shadow + Canary 운영 증거 누적 후 Production 인증 가능.');
  } else {
    console.log('🟡 Stage D 진행 중 — 세부 내용 위 확인.');
  }

  process.exit(report.ok ? 0 : 0); // Stage D는 multi-week — non-zero 종료 X
})();
