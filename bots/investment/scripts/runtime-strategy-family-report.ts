#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = []) {
  const args = {
    days: 90,
    market: 'all',
    minClosed: 3,
    json: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 90));
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'all').trim() || 'all';
    else if (raw.startsWith('--min-closed=')) args.minClosed = Math.max(1, Number(raw.split('=').slice(1).join('=') || 3));
  }
  return args;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value, digits = 1) {
  if (value == null || value === '') return 'n/a';
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${Number(value).toFixed(digits)}%`;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function weightedAverage(items, valueKey, weightKey = 'closed') {
  let totalWeight = 0;
  let weighted = 0;
  for (const item of items) {
    if (item[valueKey] == null || item[valueKey] === '') continue;
    const value = Number(item[valueKey]);
    const weight = Math.max(0, Number(item[weightKey] || 0));
    if (!Number.isFinite(value) || weight <= 0) continue;
    totalWeight += weight;
    weighted += value * weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

function aggregateFamilies(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const family = row.strategyFamily || 'unknown';
    if (!map.has(family)) {
      map.set(family, {
        strategyFamily: family,
        total: 0,
        closed: 0,
        wins: 0,
        pnlNet: 0,
        avgPnlPercent: null,
        avgReadiness: null,
        winRate: null,
        qualityCounts: {},
        marketCounts: {},
        tradeModeCounts: {},
        rows: [],
      });
    }
    const bucket = map.get(family);
    bucket.total += safeNumber(row.total);
    bucket.closed += safeNumber(row.closed);
    bucket.wins += safeNumber(row.wins);
    bucket.pnlNet += safeNumber(row.pnlNet);
    bucket.qualityCounts[row.strategyQuality] = (bucket.qualityCounts[row.strategyQuality] || 0) + safeNumber(row.total);
    bucket.marketCounts[row.market] = (bucket.marketCounts[row.market] || 0) + safeNumber(row.total);
    bucket.tradeModeCounts[row.tradeMode] = (bucket.tradeModeCounts[row.tradeMode] || 0) + safeNumber(row.total);
    bucket.rows.push(row);
  }

  return [...map.values()].map((bucket) => {
    const avgPnlPercent = weightedAverage(bucket.rows, 'avgPnlPercent', 'closed');
    const avgReadiness = weightedAverage(bucket.rows, 'avgReadiness', 'total');
    return {
      ...bucket,
      winRate: bucket.closed > 0 ? bucket.wins / bucket.closed : null,
      avgPnlPercent,
      avgReadiness,
      pnlNet: Number(bucket.pnlNet.toFixed(4)),
      rows: undefined,
    };
  }).sort((a, b) => {
    if (b.closed !== a.closed) return b.closed - a.closed;
    return safeNumber(b.avgPnlPercent, -999) - safeNumber(a.avgPnlPercent, -999);
  });
}

function normalizeRow(row) {
  const closed = safeNumber(row.closed);
  const wins = safeNumber(row.wins);
  return {
    strategyFamily: String(row.strategy_family || 'unknown'),
    strategyQuality: String(row.strategy_quality || 'unknown'),
    market: String(row.market || 'unknown'),
    exchange: String(row.exchange || 'unknown'),
    tradeMode: String(row.trade_mode || 'normal'),
    total: safeNumber(row.total),
    closed,
    wins,
    winRate: closed > 0 ? wins / closed : null,
    avgPnlPercent: row.avg_pnl_percent != null ? Number(row.avg_pnl_percent) : null,
    avgReadiness: row.avg_readiness != null ? Number(row.avg_readiness) : null,
    pnlNet: safeNumber(row.pnl_net),
    latestCreatedAt: row.latest_created_at != null ? Number(row.latest_created_at) : null,
  };
}

function topEntry(counts = {}) {
  const [key, count] = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0] || [];
  return key ? { key, count: Number(count) } : null;
}

function buildDecision({ families, rows, minClosed }) {
  const eligible = families.filter((family) => family.closed >= minClosed);
  const weakest = [...eligible]
    .filter((family) => Number.isFinite(Number(family.avgPnlPercent)))
    .sort((a, b) => safeNumber(a.avgPnlPercent, 999) - safeNumber(b.avgPnlPercent, 999))[0] || null;
  const strongest = [...eligible]
    .filter((family) => Number.isFinite(Number(family.avgPnlPercent)))
    .sort((a, b) => safeNumber(b.avgPnlPercent, -999) - safeNumber(a.avgPnlPercent, -999))[0] || null;
  const thinRows = rows.filter((row) => row.strategyQuality === 'thin');
  const thinTotal = thinRows.reduce((sum, row) => sum + safeNumber(row.total), 0);
  const total = rows.reduce((sum, row) => sum + safeNumber(row.total), 0);
  const thinRatio = total > 0 ? thinTotal / total : 0;

  let status = 'strategy_family_ok';
  let headline = '전략 패밀리 성과는 관찰 가능한 범위에서 안정적으로 누적되고 있습니다.';
  const reasons = [];
  const actionItems = [];

  if (families.length === 0) {
    status = 'strategy_family_empty';
    headline = '전략 패밀리 성과 데이터가 아직 충분히 쌓이지 않았습니다.';
    reasons.push('strategy_family가 연결된 매매일지 행이 없습니다.');
    actionItems.push('신규 신호와 매매일지가 strategy_family를 계속 저장하는지 확인합니다.');
    return { status, headline, reasons, actionItems, weakest, strongest, thinRatio };
  }

  reasons.push(`전략 패밀리 ${families.length}개, 세부 route bucket ${rows.length}개 관찰`);
  if (strongest) reasons.push(`최고 패밀리: ${strongest.strategyFamily} / 평균 ${pct(strongest.avgPnlPercent, 2)} / 승률 ${pct((strongest.winRate || 0) * 100, 1)}`);
  if (weakest) reasons.push(`최약 패밀리: ${weakest.strategyFamily} / 평균 ${pct(weakest.avgPnlPercent, 2)} / 승률 ${pct((weakest.winRate || 0) * 100, 1)}`);
  reasons.push(`thin route 비중: ${pct(thinRatio * 100, 1)}`);

  if (weakest && safeNumber(weakest.avgPnlPercent) < -2) {
    status = 'strategy_family_attention';
    headline = `${weakest.strategyFamily} 전략 패밀리의 손익률이 약해 튜닝 후보입니다.`;
    actionItems.push(`${weakest.strategyFamily} 패밀리는 신규 진입 confidence/amount bias를 보수적으로 낮추고 exit 조건을 재검토합니다.`);
  } else if (thinRatio >= 0.35) {
    status = 'strategy_family_route_thin';
    headline = 'thin route 비중이 높아 전략 추천 근거 품질을 더 보강해야 합니다.';
    actionItems.push('thin 품질 route가 많은 시장/거래모드를 찾아 analyst consensus, Argos, feedback 연결을 보강합니다.');
  } else if (weakest && safeNumber(weakest.avgPnlPercent) < 0) {
    status = 'strategy_family_watch';
    headline = `${weakest.strategyFamily} 전략 패밀리는 관찰 강화가 필요합니다.`;
    actionItems.push(`${weakest.strategyFamily} 패밀리는 즉시 차단보다 readiness와 market regime별 성과를 더 누적합니다.`);
  }

  if (strongest && safeNumber(strongest.avgPnlPercent) > 0) {
    actionItems.push(`${strongest.strategyFamily} 패밀리는 비슷한 regime에서 후보 ranking 가중치 상향을 검토합니다.`);
  }
  if (actionItems.length === 0) {
    actionItems.push('현재 route bias를 유지하며 다음 거래 집합까지 성과를 누적합니다.');
  }

  return { status, headline, reasons, actionItems, weakest, strongest, thinRatio };
}

function formatCounts(counts = {}) {
  return Object.entries(counts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([key, count]) => `${key}:${count}`)
    .join(', ') || 'n/a';
}

function formatReport(payload) {
  const { days, market, minClosed, decision, families, rows } = payload;
  const lines = [
    '🧬 Runtime Strategy Family Report',
    `period: ${days}d`,
    `market: ${market}`,
    `minClosed: ${minClosed}`,
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    '',
    '근거:',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
    '패밀리별 성과:',
  ];

  if (families.length === 0) {
    lines.push('- 데이터 없음');
  } else {
    for (const family of families.slice(0, 12)) {
      const topQuality = topEntry(family.qualityCounts);
      lines.push(`- ${family.strategyFamily}: closed ${family.closed}/${family.total}, win ${pct((family.winRate || 0) * 100, 1)}, avg ${pct(family.avgPnlPercent, 2)}, pnl ${money(family.pnlNet)}, readiness ${family.avgReadiness != null ? family.avgReadiness.toFixed(2) : 'n/a'}, topQuality ${topQuality ? `${topQuality.key}:${topQuality.count}` : 'n/a'}`);
    }
  }

  lines.push('');
  lines.push('품질/시장 bucket 상위:');
  for (const row of rows.slice(0, 12)) {
    lines.push(`- ${row.strategyFamily}/${row.strategyQuality}/${row.market}/${row.tradeMode}: total ${row.total}, closed ${row.closed}, win ${pct((row.winRate || 0) * 100, 1)}, avg ${pct(row.avgPnlPercent, 2)}, readiness ${row.avgReadiness != null ? row.avgReadiness.toFixed(2) : 'n/a'}`);
  }
  if (rows.length === 0) lines.push('- 데이터 없음');

  lines.push('');
  lines.push('권장 조치:');
  lines.push(...decision.actionItems.map((item) => `- ${item}`));

  lines.push('');
  lines.push('패밀리 coverage:');
  for (const family of families.slice(0, 8)) {
    lines.push(`- ${family.strategyFamily}: quality[${formatCounts(family.qualityCounts)}], market[${formatCounts(family.marketCounts)}], mode[${formatCounts(family.tradeModeCounts)}]`);
  }
  if (families.length === 0) lines.push('- 데이터 없음');

  return lines.join('\n');
}

export async function buildRuntimeStrategyFamilyReport({ days = 90, market = 'all', minClosed = 3, json = false } = {}) {
  await db.initSchema();
  await initJournalSchema();

  const since = Date.now() - Math.max(1, Number(days || 90)) * 24 * 60 * 60 * 1000;
  const params = [since];
  const marketFilter = String(market || 'all').trim();
  let marketSql = '';
  if (marketFilter && marketFilter !== 'all') {
    params.push(marketFilter);
    marketSql = `AND (market = ? OR exchange = ?)`;
    params.push(marketFilter);
  }

  const rawRows = await db.query(`
    SELECT
      COALESCE(NULLIF(strategy_family, ''), 'unknown') AS strategy_family,
      COALESCE(NULLIF(strategy_quality, ''), 'unknown') AS strategy_quality,
      COALESCE(NULLIF(market, ''), 'unknown') AS market,
      COALESCE(NULLIF(exchange, ''), 'unknown') AS exchange,
      COALESCE(NULLIF(trade_mode, ''), 'normal') AS trade_mode,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'closed' OR exit_time IS NOT NULL) AS closed,
      COUNT(*) FILTER (WHERE (status = 'closed' OR exit_time IS NOT NULL) AND COALESCE(pnl_net, pnl_amount, 0) > 0) AS wins,
      ROUND(AVG(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN pnl_percent ELSE NULL END)::numeric, 4) AS avg_pnl_percent,
      ROUND(AVG(strategy_readiness)::numeric, 4) AS avg_readiness,
      ROUND(SUM(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN COALESCE(pnl_net, pnl_amount, 0) ELSE 0 END)::numeric, 4) AS pnl_net,
      MAX(created_at) AS latest_created_at
    FROM trade_journal
    WHERE created_at >= ?
      ${marketSql}
      AND COALESCE(exclude_from_learning, false) = false
      AND COALESCE(NULLIF(strategy_family, ''), 'unknown') <> 'unknown'
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY total DESC, closed DESC, strategy_family ASC
  `, params);

  const rows = rawRows.map(normalizeRow);
  const families = aggregateFamilies(rows);
  const decision = buildDecision({ families, rows, minClosed });
  const payload = {
    ok: true,
    days: Number(days),
    market: marketFilter || 'all',
    minClosed: Number(minClosed),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    familyCount: families.length,
    decision,
    families,
    rows,
  };

  if (json) return payload;
  return formatReport(payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildRuntimeStrategyFamilyReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-strategy-family 오류:',
  });
}
