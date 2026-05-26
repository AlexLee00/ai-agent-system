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
const {
  buildHubStageBStabilityReport,
  writeHubStageBStabilityReport,
} = require('../lib/stage-b/stability.ts');
const {
  buildHubStageCResilienceReport,
  writeHubStageCResilienceReport,
} = require('../lib/stage-c/resilience');

async function refreshDependencyReports() {
  const stageB = await buildHubStageBStabilityReport();
  const stageBOutputPath = await writeHubStageBStabilityReport(stageB);
  const stageC = await buildHubStageCResilienceReport();
  const stageCOutputPath = await writeHubStageCResilienceReport(stageC);
  return {
    stageB: {
      ok: stageB.ok === true,
      status: stageB.status,
      checkedAt: stageB.checkedAt,
      outputPath: stageBOutputPath,
    },
    stageC: {
      ok: stageC.ok === true,
      status: stageC.status,
      checkedAt: stageC.checkedAt,
      outputPath: stageCOutputPath,
    },
  };
}

(async () => {
  const write = process.argv.includes('--write');
  const json = process.argv.includes('--json');
  const refreshDependencies = process.argv.includes('--refresh-dependencies');
  if (!json) console.log(`[stage-d] ${new Date().toISOString()} 보고서 생성 시작...`);

  let dependencyRefresh = null;
  if (refreshDependencies) {
    if (!json) console.log('[stage-d] Stage B/C dependency report refresh...');
    dependencyRefresh = await refreshDependencyReports();
  }

  const report = await buildHubStageDProductionReport();
  if (dependencyRefresh) report.dependencyRefresh = dependencyRefresh;

  if (write) {
    const outputPath = await writeHubStageDReport(report);
    report.outputPath = outputPath;
    if (!json) console.log(`[stage-d] 저장: ${outputPath}`);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 0); // Stage D는 multi-week — non-zero 종료 X
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
