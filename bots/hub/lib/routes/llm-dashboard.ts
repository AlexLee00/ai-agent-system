const pgPool = require('../../../../packages/core/lib/pg-pool');

export async function llmDashboardRoute(_req: any, res: any) {
  const html = generateDashboardHTML();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

export async function llmCacheStatsRoute(_req: any, res: any) {
  try {
    const rows = await pgPool.query('public', `
      SELECT day, cache_type, abstract_model, total_entries, total_hits, cost_saved_usd, avg_tokens
      FROM llm_cache_stats
      ORDER BY day DESC, cost_saved_usd DESC
      LIMIT 100
    `);
    const cacheEnabled = process.env.HUB_LLM_CACHE_ENABLED === 'true';
    res.json({ ok: true, cache_enabled: cacheEnabled, stats: rows, count: rows.length });
  } catch (e: any) {
    // Cache table may not exist yet
    res.json({ ok: true, cache_enabled: false, stats: [], count: 0, note: e.message });
  }
}

function generateDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Team Jay LLM Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0a0e1a; color: #e2e8f0; padding: 20px; margin: 0; }
    h1 { color: #60a5fa; margin-bottom: 4px; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-top: 16px; }
    .card { background: #1e293b; border-radius: 8px; padding: 20px; border: 1px solid #334155; }
    .metric { font-size: 2em; color: #10b981; font-weight: bold; }
    .label { color: #94a3b8; font-size: 0.9em; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
    th, td { padding: 6px 8px; border-bottom: 1px solid #334155; text-align: left; }
    th { color: #60a5fa; }
    .warn { color: #f59e0b; }
    .error { color: #ef4444; }
    .ok { color: #10b981; }
    canvas { max-height: 200px; }
  </style>
</head>
<body>
  <h1>🔮 Team Jay LLM Dashboard</h1>
  <div class="label">마지막 업데이트: <span id="ts">-</span> | <span id="status">로딩 중...</span></div>
  <div class="grid">
    <div class="card">
      <h2>전체 요약 (24h)</h2>
      <div class="metric" id="total-calls">-</div>
      <div class="label">총 호출 수</div>
      <div class="metric" id="total-cost" style="margin-top:12px">-</div>
      <div class="label">총 비용 USD | 성공률 <span id="success-rate">-</span></div>
    </div>
    <div class="card">
      <h2>팀별 비용</h2>
      <canvas id="chart-team-cost"></canvas>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>Provider 분포</h2>
      <canvas id="chart-provider"></canvas>
    </div>
    <div class="card">
      <h2>Cache 효율</h2>
      <div id="cache-stats" class="label">캐시 비활성화됨</div>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>최근 부하 테스트</h2>
      <div id="load-test-stats" class="label">로딩 중...</div>
    </div>
    <div class="card">
      <h2>운영 메모</h2>
      <div class="label">quick-smoke는 rate-limit 친화 모드로 저장됩니다.</div>
      <div class="label" style="margin-top:8px">상세 API: <code>/hub/llm/load-tests</code></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px">
    <h2>Top 에이전트 (24h)</h2>
    <table id="table-agents">
      <thead><tr><th>에이전트</th><th>팀</th><th>호출</th><th>평균 ms</th><th>비용</th><th>Fallback</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <script>
const REFRESH_MS = 30000;
let teamChart = null, providerChart = null;

async function fetchStats() {
  const r = await fetch('/hub/llm/stats?hours=24');
  return r.ok ? r.json() : null;
}
async function fetchCacheStats() {
  try { const r = await fetch('/hub/llm/cache-stats'); return r.ok ? r.json() : null; } catch { return null; }
}
async function fetchLoadTests() {
  try { const r = await fetch('/hub/llm/load-tests?limit=5'); return r.ok ? r.json() : null; } catch { return null; }
}

function renderTeamChart(stats) {
  if (!stats?.summary?.length) return;
  const ctx = document.getElementById('chart-team-cost').getContext('2d');
  if (teamChart) teamChart.destroy();
  teamChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: stats.summary.map(s => s.caller_team || '기타'),
      datasets: [{ label: '비용 USD', data: stats.summary.map(s => Number(s.total_cost_usd) || 0),
        backgroundColor: ['#60a5fa','#10b981','#f59e0b','#ef4444','#a855f7','#ec4899'] }]
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { color: '#94a3b8' } }, x: { ticks: { color: '#94a3b8' } } } }
  });
}

function renderProviderChart(stats) {
  if (!stats?.totals) return;
  const ctx = document.getElementById('chart-provider').getContext('2d');
  if (providerChart) providerChart.destroy();
  const share = stats.totals.provider_share || { 'claude-code-oauth': 0.7, 'groq': 0.3 };
  providerChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: Object.keys(share), datasets: [{ data: Object.values(share).map(v => Math.round(Number(v) * 100)),
      backgroundColor: ['#10b981','#60a5fa','#ef4444','#f59e0b'] }] },
    options: { responsive: true, plugins: { legend: { labels: { color: '#e2e8f0' } } } }
  });
}

function renderTopAgents(stats) {
  if (!stats?.by_agent) return;
  const tbody = document.querySelector('#table-agents tbody');
  tbody.innerHTML = (stats.by_agent || []).slice(0, 20).map(a => {
    const fb = Number(a.fallback_ratio || 0);
    return '<tr><td>' + (a.agent || '-') + '</td><td>' + (a.caller_team || '-') + '</td><td>' + (a.calls || 0) + '</td><td>' + Math.round(Number(a.avg_ms || 0)) + '</td><td>$' + Number(a.cost || 0).toFixed(4) + '</td><td>' + (fb > 0.1 ? '<span class=warn>' + (fb*100).toFixed(0) + '%</span>' : '<span class=ok>OK</span>') + '</td></tr>';
  }).join('');
}

function renderLoadTests(loadTests) {
  const container = document.getElementById('load-test-stats');
  if (!container) return;
  if (!loadTests?.latest) {
    container.innerHTML = '<div class="label">최근 부하 테스트 결과 없음</div>';
    return;
  }

  const latest = loadTests.latest;
  const notes = latest.notes || {};
  const scenarioSummary = Array.isArray(loadTests.scenario_summary) ? loadTests.scenario_summary : [];
  const scenarioNote = notes.scenarioNote ? '<div class="label" style="margin-top:8px">' + notes.scenarioNote + '</div>' : '';
  const providerCounts = notes.providerCounts
    ? Object.entries(notes.providerCounts).map(([k, v]) => k + ': ' + v).join(', ')
    : '-';
  const summaryLines = scenarioSummary.length
    ? '<div class="label" style="margin-top:12px">시나리오별 최신: ' + scenarioSummary.map((item) =>
      item.scenario + ' ' + (Number(item.fail_rate || 0) * 100).toFixed(0) + '% / ' + Math.round(Number(item.avg_ms || 0)) + 'ms'
    ).join(' | ') + '</div>'
    : '';

  container.innerHTML =
    '<div class="metric">' + (latest.scenario || '-') + '</div>' +
    '<div class="label">실패율 ' + (Number(latest.fail_rate || 0) * 100).toFixed(1) + '% | 평균 ' + Math.round(Number(latest.avg_ms || 0)) + 'ms</div>' +
    '<div class="label" style="margin-top:8px">총 ' + (latest.total_requests || 0) + '건 / 실패 ' + (latest.failed_requests || 0) + '건 / duration ' + Number(latest.duration_s || 0).toFixed(1) + 's</div>' +
    '<div class="label" style="margin-top:8px">provider: ' + providerCounts + '</div>' +
    summaryLines +
    scenarioNote;
}

async function refresh() {
  try {
    const [stats, cacheStats, loadTests] = await Promise.all([fetchStats(), fetchCacheStats(), fetchLoadTests()]);
    document.getElementById('ts').textContent = new Date().toLocaleString('ko-KR');
    if (stats?.totals) {
      document.getElementById('total-calls').textContent = (stats.totals.total_calls || 0).toLocaleString();
      document.getElementById('total-cost').textContent = '$' + Number(stats.totals.total_cost_usd || 0).toFixed(2);
      document.getElementById('success-rate').textContent = (Number(stats.totals.success_rate || 1) * 100).toFixed(1) + '%';
    }
    renderTeamChart(stats);
    renderProviderChart(stats);
    renderTopAgents(stats);
    renderLoadTests(loadTests);
    if (cacheStats?.cache_enabled && cacheStats.stats?.length) {
      const totalHits = cacheStats.stats.reduce((s, r) => s + Number(r.total_hits || 0), 0);
      const saved = cacheStats.stats.reduce((s, r) => s + Number(r.cost_saved_usd || 0), 0);
      document.getElementById('cache-stats').innerHTML = '<div class="metric">' + totalHits + '</div><div class="label">캐시 히트 | 절감 $' + saved.toFixed(4) + '</div>';
    }
    document.getElementById('status').textContent = '정상';
  } catch(e) {
    document.getElementById('status').textContent = '오류: ' + e.message;
  }
}
refresh();
setInterval(refresh, REFRESH_MS);
  </script>
</body>
</html>`;
}
