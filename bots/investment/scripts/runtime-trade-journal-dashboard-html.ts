#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db/core.ts';

const DEFAULT_OUTPUT = path.resolve('output/dashboard/trade-journal.html');

// ── DB 쿼리 ────────────────────────────────────────────────────────────────────

async function fetchDailyTradeSummary(days = 30) {
  return query(
    `SELECT
       DATE(executed_at AT TIME ZONE 'Asia/Seoul') AS day,
       exchange,
       CASE
         WHEN exchange = 'binance' THEN 'crypto'
         WHEN exchange ILIKE '%overseas%' THEN 'overseas'
         ELSE 'domestic'
       END AS market,
       COUNT(*) AS trades,
       SUM(CASE WHEN LOWER(side)='buy' THEN 1 ELSE 0 END) AS buys,
       SUM(CASE WHEN LOWER(side)='sell' THEN 1 ELSE 0 END) AS sells,
       ROUND(AVG(CASE WHEN realized_pnl_pct IS NOT NULL THEN realized_pnl_pct END)::numeric, 4) AS avg_pnl_pct,
       ROUND(SUM(COALESCE(realized_pnl_usdt, 0))::numeric, 2) AS total_pnl_usdt
     FROM trades
     WHERE executed_at >= NOW() - ($1 * INTERVAL '1 day')
     GROUP BY 1, 2, 3
     ORDER BY 1 DESC, 3`,
    [days],
  ).catch(() => []);
}

async function fetchSignalFailureSummary() {
  return query(
    `SELECT
       COALESCE(block_reason, 'unknown') AS reason,
       COUNT(*) AS cnt,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER(), 1) AS pct
     FROM signals
     WHERE status IN ('failed', 'blocked')
       AND created_at >= NOW() - INTERVAL '30 days'
     GROUP BY 1
     ORDER BY 2 DESC
     LIMIT 15`,
    [],
  ).catch(() => []);
}

async function fetchMarketSuccessRate() {
  return query(
    `SELECT
       CASE
         WHEN exchange = 'binance' THEN 'crypto'
         WHEN exchange ILIKE '%overseas%' THEN 'overseas'
         ELSE 'domestic'
       END AS market,
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END) AS executed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       ROUND(100.0 * SUM(CASE WHEN status='executed' THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS success_pct
     FROM signals
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY 1
     ORDER BY 1`,
    [],
  ).catch(() => []);
}

async function fetchReflexionCount() {
  return query(
    `SELECT COUNT(*) AS total FROM luna_failure_reflexions
     WHERE created_at >= NOW() - INTERVAL '30 days'`,
    [],
  ).catch(() => [{ total: 0 }]);
}

async function fetchSkillCount() {
  return query(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT market) AS markets FROM luna_posttrade_skills`,
    [],
  ).catch(() => [{ total: 0, markets: 0 }]);
}

async function fetchTpSlStats() {
  return query(
    `SELECT
       COUNT(*) AS total_buys,
       SUM(CASE WHEN tp_sl_set THEN 1 ELSE 0 END) AS tp_sl_set_count,
       ROUND(100.0 * SUM(CASE WHEN tp_sl_set THEN 1 ELSE 0 END) / NULLIF(COUNT(*),0), 1) AS tp_sl_pct
     FROM trades
     WHERE LOWER(side) = 'buy'
       AND executed_at >= NOW() - INTERVAL '30 days'`,
    [],
  ).catch(() => [{ total_buys: 0, tp_sl_set_count: 0, tp_sl_pct: 0 }]);
}

async function fetchTopPnlTrades(limit = 10) {
  return query(
    `SELECT symbol, exchange, realized_pnl_pct, realized_pnl_usdt, executed_at
       FROM trades
      WHERE LOWER(side) = 'sell'
        AND realized_pnl_pct IS NOT NULL
      ORDER BY ABS(realized_pnl_pct) DESC
      LIMIT $1`,
    [limit],
  ).catch(() => []);
}

// ── HTML 빌더 ──────────────────────────────────────────────────────────────────

function esc(val) {
  return String(val ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pnlColor(pct) {
  const v = Number(pct);
  if (!Number.isFinite(v)) return '#888';
  return v >= 0 ? '#27ae60' : '#e74c3c';
}

export async function buildTradeJournalDashboard() {
  const [daily, failures, marketRates, reflexions, skills, tpsl, topPnl] = await Promise.all([
    fetchDailyTradeSummary(30),
    fetchSignalFailureSummary(),
    fetchMarketSuccessRate(),
    fetchReflexionCount(),
    fetchSkillCount(),
    fetchTpSlStats(),
    fetchTopPnlTrades(10),
  ]);

  const totalTrades = daily.reduce((s, r) => s + Number(r.trades || 0), 0);
  const totalPnl = daily.reduce((s, r) => s + Number(r.total_pnl_usdt || 0), 0);
  const reflexionTotal = Number(reflexions[0]?.total || 0);
  const skillTotal = Number(skills[0]?.total || 0);
  const tpslRow = tpsl[0] || {};

  // 일별 거래 차트 데이터
  const chartLabels = [...new Set(daily.map((r) => r.day))].sort().slice(-14);
  const chartData = chartLabels.map((day) => {
    const rows = daily.filter((r) => r.day === day);
    return rows.reduce((s, r) => s + Number(r.trades || 0), 0);
  });

  const dailyTableRows = daily.slice(0, 60).map((r) =>
    `<tr>
      <td>${esc(r.day)}</td>
      <td>${esc(r.market)}</td>
      <td>${esc(r.trades)}</td>
      <td>${esc(r.buys)}</td>
      <td>${esc(r.sells)}</td>
      <td style="color:${pnlColor(r.avg_pnl_pct)}">${r.avg_pnl_pct != null ? (Number(r.avg_pnl_pct) * 100).toFixed(2) + '%' : '-'}</td>
      <td style="color:${pnlColor(r.total_pnl_usdt)}">${r.total_pnl_usdt != null ? Number(r.total_pnl_usdt).toFixed(2) : '-'}</td>
    </tr>`
  ).join('');

  const marketRows = marketRates.map((r) =>
    `<tr>
      <td>${esc(r.market)}</td>
      <td>${esc(r.total)}</td>
      <td>${esc(r.executed)}</td>
      <td>${esc(r.failed)}</td>
      <td>${esc(r.success_pct)}%</td>
    </tr>`
  ).join('');

  const failureRows = failures.map((r) =>
    `<tr><td>${esc(r.reason)}</td><td>${esc(r.cnt)}</td><td>${esc(r.pct)}%</td></tr>`
  ).join('');

  const topPnlRows = topPnl.map((r) =>
    `<tr>
      <td>${esc(r.symbol)}</td>
      <td>${esc(r.exchange)}</td>
      <td style="color:${pnlColor(r.realized_pnl_pct)}">${(Number(r.realized_pnl_pct) * 100).toFixed(2)}%</td>
      <td style="color:${pnlColor(r.realized_pnl_usdt)}">${Number(r.realized_pnl_usdt).toFixed(2)}</td>
      <td>${esc(String(r.executed_at).slice(0, 16))}</td>
    </tr>`
  ).join('');

  const generatedAt = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Luna 매매일지 Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #0f1117; color: #e0e0e0; }
    h1 { color: #a78bfa; margin-bottom: 4px; }
    .sub { color: #888; font-size: 13px; margin-bottom: 24px; }
    .cards { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 32px; }
    .card { background: #1e2130; border-radius: 8px; padding: 16px 24px; min-width: 160px; }
    .card .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
    .card .value { font-size: 28px; font-weight: bold; margin-top: 4px; }
    .card .value.green { color: #27ae60; }
    .card .value.red { color: #e74c3c; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 32px; font-size: 13px; }
    th { background: #1e2130; padding: 8px 12px; text-align: left; color: #a0a0a0; font-weight: 600; }
    td { padding: 6px 12px; border-bottom: 1px solid #1e2130; }
    tr:hover td { background: #1e2130; }
    h2 { color: #c4b5fd; font-size: 16px; margin: 24px 0 8px; }
    .canvas-wrap { background: #1e2130; border-radius: 8px; padding: 16px; margin-bottom: 32px; }
    canvas { max-height: 200px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
  <h1>Luna 매매일지 Dashboard</h1>
  <div class="sub">생성: ${generatedAt} | 최근 30일 기준</div>

  <div class="cards">
    <div class="card">
      <div class="label">총 거래</div>
      <div class="value">${totalTrades}</div>
    </div>
    <div class="card">
      <div class="label">실현 PnL (USDT)</div>
      <div class="value ${totalPnl >= 0 ? 'green' : 'red'}">${totalPnl.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="label">Reflexion 누적</div>
      <div class="value">${reflexionTotal}</div>
    </div>
    <div class="card">
      <div class="label">Skill Library</div>
      <div class="value">${skillTotal}</div>
    </div>
    <div class="card">
      <div class="label">TP/SL 설정률</div>
      <div class="value ${Number(tpslRow.tp_sl_pct) >= 80 ? 'green' : 'red'}">${tpslRow.tp_sl_pct ?? 0}%</div>
    </div>
  </div>

  <div class="canvas-wrap">
    <h2>일별 거래 수 (최근 14일)</h2>
    <canvas id="tradeChart"></canvas>
  </div>

  <h2>시장별 신호 성공률</h2>
  <table>
    <thead><tr><th>시장</th><th>총 신호</th><th>실행</th><th>실패</th><th>성공률</th></tr></thead>
    <tbody>${marketRows || '<tr><td colspan="5">데이터 없음</td></tr>'}</tbody>
  </table>

  <h2>신호 실패 사유 TOP</h2>
  <table>
    <thead><tr><th>사유</th><th>건수</th><th>비율</th></tr></thead>
    <tbody>${failureRows || '<tr><td colspan="3">데이터 없음</td></tr>'}</tbody>
  </table>

  <h2>일별 거래 현황 (최근 30일)</h2>
  <table>
    <thead><tr><th>날짜</th><th>시장</th><th>거래</th><th>매수</th><th>매도</th><th>평균PnL%</th><th>PnL(USDT)</th></tr></thead>
    <tbody>${dailyTableRows || '<tr><td colspan="7">데이터 없음</td></tr>'}</tbody>
  </table>

  <h2>PnL 상위 거래 (절댓값 기준)</h2>
  <table>
    <thead><tr><th>심볼</th><th>거래소</th><th>PnL%</th><th>PnL(USDT)</th><th>시각</th></tr></thead>
    <tbody>${topPnlRows || '<tr><td colspan="5">데이터 없음 (backfill 후 채워짐)</td></tr>'}</tbody>
  </table>

  <script>
    new Chart(document.getElementById('tradeChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(chartLabels)},
        datasets: [{ label: '거래 수', data: ${JSON.stringify(chartData)}, backgroundColor: '#7c3aed' }]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#ccc' } } },
        scales: {
          x: { ticks: { color: '#aaa' }, grid: { color: '#333' } },
          y: { ticks: { color: '#aaa' }, grid: { color: '#333' }, beginAtZero: true }
        }
      }
    });
  </script>
</body>
</html>`;

  return { ok: true, totalTrades, totalPnl, reflexionTotal, skillTotal, daily, failures, marketRates, tpsl: tpslRow, topPnl, html };
}

export async function writeTradeJournalDashboard({ output = DEFAULT_OUTPUT, write = true } = {}) {
  const dashboard = await buildTradeJournalDashboard();
  if (write) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, dashboard.html);
  }
  return { ok: dashboard.ok, totalTrades: dashboard.totalTrades, totalPnl: dashboard.totalPnl, output: write ? output : null };
}

async function main() {
  const noWrite = process.argv.includes('--no-write');
  const result = await writeTradeJournalDashboard({ write: !noWrite });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`runtime-trade-journal-dashboard-html ok trades=${result.totalTrades} pnl=${result.totalPnl?.toFixed(2)}`);
    if (!noWrite) console.log(`  → ${result.output}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-trade-journal-dashboard-html 실패:' });
}
