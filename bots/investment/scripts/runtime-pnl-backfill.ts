#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-pnl-backfill — 기존 668 trades BUY-SELL FIFO 매칭 후 realized_pnl 일괄 계산
 *
 * 사용법:
 *   node runtime-pnl-backfill.ts --json
 *   node runtime-pnl-backfill.ts --apply --confirm=runtime-pnl-backfill --json
 *   --json  플래그: JSON 출력
 */
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { backfillAllRealizedPnl, fetchDistinctSymbolsWithUnmatchedSells } from '../shared/realized-pnl-calculator.ts';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

async function main() {
  const apply = process.argv.includes('--apply') || boolEnv('APPLY', false);
  const confirm = process.argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || process.env.CONFIRM || null;
  if (apply && confirm !== 'runtime-pnl-backfill') {
    throw new Error('apply requires --confirm=runtime-pnl-backfill');
  }
  const dryRun = !apply;
  const jsonOut = process.argv.includes('--json');
  const limit = Number(process.env.LIMIT || 1000);

  if (!jsonOut) {
    console.log(`[pnl-backfill] 시작 dryRun=${dryRun} (실제 적용: APPLY=true)`);
  }

  const pending = await fetchDistinctSymbolsWithUnmatchedSells();
  if (!jsonOut) {
    console.log(`[pnl-backfill] 미매칭 SELL 보유 심볼 ${pending.length}개 발견`);
  }

  const result = await backfillAllRealizedPnl({ dryRun, limit });

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`[pnl-backfill] 완료 —`);
  console.log(`  심볼 처리: ${result.symbolPairsProcessed}`);
  console.log(`  매칭 성공: ${result.totalMatched}`);
  console.log(`  매칭 실패: ${result.totalSkipped}`);
  console.log(`  dryRun: ${result.dryRun}`);

  if (result.results?.length) {
    const top = result.results
      .filter((r) => r.matched > 0)
      .slice(0, 10);
    for (const r of top) {
      const pnlList = (r.realized || []).filter((x) => x.ok).map((x) => x.realizedPnlPct?.toFixed(4));
      console.log(`  ${r.symbol}/${r.exchange}: ${r.matched}건 매칭, pnl_pct=[${pnlList.join(', ')}]`);
    }
  }

  if (dryRun) {
    console.log('\n  ⚠ dry-run 모드: DB 업데이트 안 됨. 실제 적용하려면 --apply --confirm=runtime-pnl-backfill');
  } else {
    console.log('\n  ✓ DB 업데이트 완료');
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-pnl-backfill 실패:' });
}
