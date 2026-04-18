/**
 * LLM Routing 일일 리포트 — 매일 KST 06:00 자동 실행
 * launchd ai.llm.daily-report.plist로 트리거됨
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const telegramSender = require('../../../packages/core/lib/telegram-sender');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';

async function fetchStats(hours: number, team?: string): Promise<any> {
  const url = team
    ? `${HUB_BASE}/hub/llm/stats?hours=${hours}&team=${team}`
    : `${HUB_BASE}/hub/llm/stats?hours=${hours}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Hub stats ${resp.status}`);
  return resp.json();
}

async function generateReport() {
  const data = await fetchStats(24);
  const { totals = {}, summary = [], by_agent = [], groq_pool_size = 0 } = data;

  const lines: string[] = [];
  lines.push('📊 *LLM Routing 일일 리포트 (24h)*');
  lines.push('');
  lines.push(`총 호출: ${totals.total_calls ?? 0}회`);
  lines.push(`총 비용: $${Number(totals.total_cost_usd ?? 0).toFixed(4)}`);
  lines.push(`성공률: ${((totals.success_rate ?? 0) * 100).toFixed(1)}%`);
  lines.push(`Groq 풀: ${groq_pool_size}계정`);
  lines.push('');

  if (summary.length > 0) {
    lines.push('*Provider별 분포:*');
    for (const row of summary) {
      const label = row.provider === 'claude-code-oauth' ? '🧠 OAuth'
        : row.provider === 'groq' ? '⚡ Groq'
        : '❌ Failed';
      const team = row.caller_team ? `[${row.caller_team}]` : '';
      lines.push(`  ${label}${team}: ${row.total_calls}회 avg ${row.avg_duration_ms}ms $${Number(row.total_cost_usd || 0).toFixed(4)}`);
    }
    lines.push('');
  }

  if (by_agent.length > 0) {
    lines.push('*Top 에이전트:*');
    for (const row of by_agent.slice(0, 5)) {
      lines.push(`  \`${row.agent}\` (${row.provider}): ${row.calls}회 avg ${row.avg_ms}ms`);
    }
  }

  const message = lines.join('\n');
  console.log('[llm-daily-report]', message);
  await telegramSender.send('general', message);
  console.log('[llm-daily-report] Telegram 전송 완료');
}

generateReport().catch((err: Error) => {
  console.error('[llm-daily-report] 실패:', err.message);
  process.exit(1);
});
