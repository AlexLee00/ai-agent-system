#!/usr/bin/env tsx

const assert = require('node:assert/strict');

async function main() {
  const report = require('./llm-daily-report.ts');
  const sent: Array<{ channel: string; message: string }> = [];
  const queries: string[] = [];

  report._testOnly.setDependencies({
    fetchImpl: async () => new Response(JSON.stringify({ error: 'rate limit exceeded (200/min)' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }) as any,
    telegramSender: {
      send: async (channel: string, message: string) => {
        sent.push({ channel, message });
        return true;
      },
    },
    pgPool: {
      query: async (_schema: string, sql: string) => {
        queries.push(sql);
        if (sql.includes('GROUP BY agent, provider')) {
          return [{ agent: 'agent-a', provider: 'groq', calls: 3, avg_ms: 120 }];
        }
        if (sql.includes('date_trunc')) {
          return [{ hour: new Date().toISOString(), provider: 'groq', calls: 3, cost: 0 }];
        }
        return [
          {
            provider: 'groq',
            caller_team: 'hub',
            total_calls: 3,
            success_count: 2,
            avg_duration_ms: 120,
            max_duration_ms: 200,
            total_cost_usd: 0,
            unique_agents: 1,
            total_fallbacks: 0,
          },
        ];
      },
    },
  });

  const result = await report.generateReport();
  assert.equal(result.ok, true);
  assert.equal(result.statsSource, 'db_fallback');
  assert.equal(sent.length, 1, 'fallback report should still send one telegram message');
  assert.equal(sent[0].channel, 'general');
  assert(sent[0].message.includes('통계 소스: DB fallback'), 'report must disclose DB fallback source');
  assert(sent[0].message.includes('총 호출: 3회'), 'report must use fallback DB totals');
  assert(queries.length >= 3, 'fallback must run DB summary, by-agent, and by-hour queries');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'llm-daily-report-fallback',
    stats_source: result.statsSource,
    sent: sent.length,
  }));
}

main().catch((error: Error) => {
  console.error(error);
  process.exit(1);
});
