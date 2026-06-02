#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-vault-on-gate.ts — S1.3-3 C2 L2 ON 전환 게이트
 *
 * luna_vault_shadow_eval을 (market, family, direction)별로 집계하고,
 * 게이트 조건을 판정해 ON 후보를
 * investment.luna_vault_shadow_on_candidates에 기록한다.
 *
 * 실행:
 *   node bots/investment/scripts/luna-vault-on-gate.ts --json
 *   node bots/investment/scripts/luna-vault-on-gate.ts --dry-run --json
 *   node bots/investment/scripts/luna-vault-on-gate.ts --report --json
 */

import {
  buildOnGateReport,
  computeOnGate,
} from '../shared/luna-vault-on-gate.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const REPORT_ONLY = process.argv.includes('--report') || process.argv.includes('--report-only');
const JSON_OUTPUT = process.argv.includes('--json');

function formatRate(value: number | null | undefined): string {
  return value == null ? 'N/A' : `${(Number(value) * 100).toFixed(1)}%`;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  if (REPORT_ONLY) {
    const report = await buildOnGateReport({ limit: 500 });
    if (JSON_OUTPUT) {
      printJson({ mode: 'report_only', ...report });
      return;
    }

    console.log('\n--- L2 ON 후보 현황 (luna_vault_shadow_on_candidates) ---');
    console.log(`전체: ${report.totalRecords} | PASS: ${report.passed} | BLOCK: ${report.blocked}`);
    if (Object.keys(report.blockReasonSummary).length > 0) {
      console.log(
        'BLOCK 사유:',
        Object.entries(report.blockReasonSummary).map(([k, v]) => `${k}=${v}`).join(', '),
      );
    }
    for (const row of report.passedCandidates) {
      console.log(
        `  PASS | ${row.market}/${row.family}/${row.direction}` +
        ` | sample=${row.sampleN} vault=${formatRate(row.vaultHitRate)}` +
        ` base=${formatRate(row.baseHitRate)} lift=${formatRate(row.lift)}` +
        ` days=${row.evalDays}`,
      );
    }
    for (const row of report.blockedGroups) {
      console.log(
        `  BLOCK | ${row.market}/${row.family}/${row.direction}` +
        ` | sample=${row.sampleN} vault=${formatRate(row.vaultHitRate)}` +
        ` reason=${row.gateReason ?? 'none'}`,
      );
    }
    console.log('-------------------------------------------------------');
    return;
  }

  const result = await computeOnGate({ write: !DRY_RUN });
  if (JSON_OUTPUT) {
    printJson({ dryRun: DRY_RUN, ...result });
    return;
  }

  console.log('\n--- L2 ON 게이트 계산 결과 ---');
  console.log(`그룹 수: ${result.groups} | PASS: ${result.passed} | BLOCK: ${result.blocked}`);
  console.log(`기록 대상: ${result.write ? 'investment.luna_vault_shadow_on_candidates' : 'none(dry-run)'}`);
  console.log(
    `게이트 설정: minHit=${result.config.minHit} minSample=${result.config.minSample} minDays=${result.config.minDays}`,
  );
  for (const row of result.results) {
    console.log(
      `  ${row.gateStatus.toUpperCase()} | ${row.market}/${row.family}/${row.direction}` +
      ` | sample=${row.sampleN} vault=${formatRate(row.vaultHitRate)}` +
      ` base=${formatRate(row.baseHitRate)} lift=${formatRate(row.lift)}` +
      ` days=${row.evalDays}` +
      (row.gateReason ? ` reason=${row.gateReason}` : ''),
    );
  }
  console.log('----------------------------');
}

main().catch((error) => {
  console.error('[vault-on-gate] 치명적 오류:', error?.message ?? error);
  process.exit(1);
});
