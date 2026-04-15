#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = []) {
  const args = {
    symbol: null,
    days: 30,
    limit: 20,
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 30));
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 20));
  }

  return args;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function topBy(rows = [], field = 'sharpe') {
  return [...rows]
    .filter((row) => row.status === 'ok')
    .sort((a, b) => safeNumber(b[field]) - safeNumber(a[field]))[0] || null;
}

function buildDecision(rows = []) {
  const okRows = rows.filter((row) => row.status === 'ok');
  const errorRows = rows.filter((row) => row.status !== 'ok');
  const bestSharpe = topBy(okRows, 'sharpe');
  const bestReturn = topBy(okRows, 'total_return');

  let status = 'backtest_idle';
  let headline = '최근 VectorBT 결과가 없습니다.';
  const reasons = [];
  const actionItems = [];

  if (rows.length > 0) {
    status = errorRows.length > 0 ? 'backtest_attention' : 'backtest_ok';
    headline = errorRows.length > 0
      ? '최근 VectorBT 결과에 오류/의존성 이슈가 섞여 있습니다.'
      : '최근 VectorBT 결과가 정상적으로 쌓이고 있습니다.';
    reasons.push(`최근 결과 ${rows.length}건 (ok ${okRows.length} / issue ${errorRows.length})`);
    if (bestSharpe) {
      reasons.push(`최고 샤프: ${bestSharpe.symbol} ${bestSharpe.label} (${safeNumber(bestSharpe.sharpe).toFixed(2)})`);
    }
    if (bestReturn) {
      reasons.push(`최고 수익률: ${bestReturn.symbol} ${bestReturn.label} (${safeNumber(bestReturn.total_return).toFixed(2)}%)`);
    }
  }

  if (errorRows.length > 0) {
    actionItems.push('오류 상태 결과의 metadata.error / missing 의존성을 우선 점검합니다.');
  }
  if (bestSharpe) {
    actionItems.push('최고 샤프 조합을 runtime parameter allow 후보와 비교합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('VectorBT 결과를 계속 누적하며 성과 악화/개선 추세를 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total: rows.length,
      ok: okRows.length,
      issue: errorRows.length,
      bestSharpe: bestSharpe ? {
        symbol: bestSharpe.symbol,
        label: bestSharpe.label,
        sharpe: safeNumber(bestSharpe.sharpe),
      } : null,
      bestReturn: bestReturn ? {
        symbol: bestReturn.symbol,
        label: bestReturn.label,
        totalReturn: safeNumber(bestReturn.total_return),
      } : null,
    },
  };
}

function renderText(payload) {
  const lines = [
    '📈 VectorBT Backtest Report',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '최근 결과:',
    ...payload.rows.slice(0, 8).map((row) =>
      `- ${row.symbol} | ${row.label || 'n/a'} | ${row.status} | sharpe=${safeNumber(row.sharpe).toFixed(2)} | return=${safeNumber(row.total_return).toFixed(2)}%`
    ),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildVectorBtBacktestReport(args = {}) {
  await db.initSchema();
  const params = [args.days, args.limit];
  let sql = `
    SELECT symbol, days, tp_pct, sl_pct, label, status, sharpe, total_return, max_drawdown, win_rate, total_trades, metadata, created_at
    FROM vectorbt_backtest_runs
    WHERE created_at > now() - ($1::int || ' days')::interval
  `;

  if (args.symbol) {
    sql += ` AND symbol = $3 `;
    params.push(args.symbol);
  }

  sql += ` ORDER BY created_at DESC LIMIT $2::int `;
  const rows = await db.query(sql, params);
  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    args,
    rows,
    decision,
  };

  if (args.json) return payload;
  return renderText(payload);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return buildVectorBtBacktestReport(args);
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ vectorbt-backtest-report 오류:',
  });
}
