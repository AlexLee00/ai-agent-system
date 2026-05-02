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
  const totalCalls = Number(totals.total_calls || 0);

  const lines: string[] = [];
  lines.push('📊 *LLM Routing 일일 리포트 (24h)*');
  lines.push('');
  lines.push(`총 호출: ${totalCalls}회`);
  lines.push(`총 비용: $${Number(totals.total_cost_usd ?? 0).toFixed(4)}`);
  lines.push(`성공률: ${((totals.success_rate ?? 0) * 100).toFixed(1)}%`);
  lines.push(`Groq 풀: ${groq_pool_size}계정`);
  lines.push('');

  if (summary.length > 0) {
    lines.push('*Provider별 분포:*');
    for (const row of summary) {
      const provider = String(row.provider || '');
      const label = provider === 'claude-code-oauth' ? '🧠 Claude Code OAuth'
        : provider === 'openai-oauth' ? '🟩 OpenAI OAuth'
          : provider === 'gemini-cli-oauth' ? '🟦 Gemini CLI OAuth'
            : provider === 'gemini-oauth' ? '🟪 Gemini OAuth'
              : provider === 'groq' ? '⚡ Groq'
                : provider === 'failed' ? '❌ Failed'
                  : `🔹 ${provider || 'unknown'}`;
      const team = row.caller_team ? `[${row.caller_team}]` : '';
      const calls = Number(row.total_calls || 0);
      const sharePct = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
      const providerSuccessRate = calls > 0 ? (Number(row.success_count || 0) / calls) * 100 : 0;
      lines.push(
        `  ${label}${team}: ${calls}회 (${sharePct.toFixed(1)}%) `
        + `성공률 ${providerSuccessRate.toFixed(1)}% avg ${row.avg_duration_ms}ms `
        + `$${Number(row.total_cost_usd || 0).toFixed(4)}`,
      );
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
