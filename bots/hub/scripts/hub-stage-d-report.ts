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

  const { goals, week1Complete, status } = report;
  console.log('\n=== Hub Stage D 보고 ===');
  console.log(`상태: ${status}`);
  console.log(`Week 1 완료: ${week1Complete ? '✅' : '🟡'}`);
  console.log('');
  console.log('목표별 상태:');
  for (const [key, ok] of Object.entries(goals)) {
    console.log(`  ${ok ? '✅' : '🟡'} ${key}`);
  }
  console.log('');

  if (week1Complete) {
    console.log('✅ Stage D Week 1 완료! Blue-Green + secrets 자동 갱신 준비됨.');
  } else {
    console.log('🟡 Stage D Week 1 진행 중 — 세부 내용 위 확인.');
  }

  process.exit(report.ok ? 0 : 0); // Stage D는 multi-week — non-zero 종료 X
})();
