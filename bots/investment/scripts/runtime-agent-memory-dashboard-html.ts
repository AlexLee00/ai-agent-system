#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-agent-memory-dashboard-html.ts — Phase Ω5: Memory Dashboard UI
 *
 * Luna 4-Layer Memory 시스템 상태 가시화.
 * HTML 또는 CLI 출력 (기본 CLI).
 *
 * 출력 내용:
 *   1. 4-Layer Memory 통계 (L1~L4)
 *   2. 12 에이전트별 retrieval count
 *   3. Reflexion 누적 카운트
 *   4. LLM Routing health summary
 *   5. Cross-Agent Bus 활성도
 *
 * Kill Switch:
 *   LUNA_MEMORY_DASHBOARD_HTML_ENABLED=false → 전체 비활성
 *   LUNA_MEMORY_DASHBOARD_OUTPUT_PATH=output/dashboard/ → HTML 출력 경로
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

const ENABLED = () => {
  const raw = String(process.env.LUNA_MEMORY_DASHBOARD_HTML_ENABLED ?? 'false').toLowerCase();
  return raw !== 'false' && raw !== '0';
};

const OUTPUT_PATH = () =>
  process.env.LUNA_MEMORY_DASHBOARD_OUTPUT_PATH
  || path.join(INVESTMENT_DIR, 'output', 'dashboard');

const LUNA_AGENTS = [
  'luna', 'argos', 'aria', 'sophia', 'hermes', 'oracle',
  'nemesis', 'hephaestos', 'hanul', 'chronos', 'zeus', 'athena',
];

export interface DashboardData {
  generatedAt: string;
  layer1: { count: number };
  layer2: { count: number; agents: number };
  layer3: { ragDocCount: number; reflexionCount: number };
  layer4: { entityFactCount: number; skillCount: number };
  agentRetrievals: Array<{ agent: string; count: number; lastActivity: string | null }>;
  reflexions: {
    failureCount: number;
    llmFailureCount: number;
    recent5: Array<{ symbol: string; hindsight: string; createdAt: string }>;
  };
  llmRouting: {
    totalCalls: number;
    successRate: number;
    providerBreakdown: Array<{ provider: string; count: number; avgMs: number }>;
  };
  crossBus: {
    totalMessages: number;
    pendingMessages: number;
    agentActivity: Array<{ agent: string; pending: number }>;
  };
}

async function collectLayer1Stats(): Promise<{ count: number }> {
  const row = await db.get(
    `SELECT COUNT(*)::int AS cnt FROM information_schema.tables
     WHERE table_schema = 'investment' AND table_name = 'agent_working_memory'`,
    [],
  ).catch(() => null);
  if (!row || row.cnt === 0) return { count: 0 };
  const r = await db.get(
    `SELECT COUNT(*)::int AS cnt FROM investment.agent_working_memory`,
    [],
  ).catch(() => null);
  return { count: Number(r?.cnt || 0) };
}

async function collectLayer2Stats(): Promise<{ count: number; agents: number }> {
  const r = await db.get(
    `SELECT
       COUNT(*)::int AS cnt,
       COUNT(DISTINCT agent_name)::int AS agents
     FROM investment.agent_short_term_memory
     WHERE expires_at > NOW() OR expires_at IS NULL`,
    [],
  ).catch(() => null);
  return {
    count: Number(r?.cnt || 0),
    agents: Number(r?.agents || 0),
  };
}

async function collectLayer3Stats(): Promise<{ ragDocCount: number; reflexionCount: number }> {
  const [rag, reflex] = await Promise.allSettled([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_rag_documents`, []),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions`, []),
  ]);
  return {
    ragDocCount: Number((rag.status === 'fulfilled' ? rag.value?.cnt : null) || 0),
    reflexionCount: Number((reflex.status === 'fulfilled' ? reflex.value?.cnt : null) || 0),
  };
}

async function collectLayer4Stats(): Promise<{ entityFactCount: number; skillCount: number }> {
  const [facts, skills] = await Promise.allSettled([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.entity_facts`, []),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.skill_library`, []),
  ]);
  return {
    entityFactCount: Number((facts.status === 'fulfilled' ? facts.value?.cnt : null) || 0),
    skillCount: Number((skills.status === 'fulfilled' ? skills.value?.cnt : null) || 0),
  };
}

async function collectAgentRetrievals(): Promise<Array<{ agent: string; count: number; lastActivity: string | null }>> {
  const rows = await db.query(
    `SELECT
       agent_name,
       COUNT(*)::int AS cnt,
       MAX(created_at)::text AS last_activity
     FROM investment.agent_memory_retrievals
     WHERE created_at > NOW() - INTERVAL '7 days'
     GROUP BY agent_name
     ORDER BY cnt DESC
     LIMIT 20`,
    [],
  ).catch(() => []);

  const dbMap = new Map((rows || []).map((r: any) => [r.agent_name, { count: Number(r.cnt), lastActivity: r.last_activity }]));

  return LUNA_AGENTS.map(agent => ({
    agent,
    count: dbMap.get(agent)?.count ?? 0,
    lastActivity: dbMap.get(agent)?.lastActivity ?? null,
  }));
}

async function collectReflexions(): Promise<DashboardData['reflexions']> {
  const [failure, llmFail, recent] = await Promise.allSettled([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions`, []),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.llm_failure_reflexions`, []),
    db.query(
      `SELECT symbol, hindsight, created_at
       FROM investment.luna_failure_reflexions
       ORDER BY created_at DESC LIMIT 5`,
      [],
    ),
  ]);

  return {
    failureCount: Number((failure.status === 'fulfilled' ? failure.value?.cnt : null) || 0),
    llmFailureCount: Number((llmFail.status === 'fulfilled' ? llmFail.value?.cnt : null) || 0),
    recent5: (recent.status === 'fulfilled' ? recent.value : []).map((r: any) => ({
      symbol: r.symbol,
      hindsight: String(r.hindsight || '').slice(0, 80),
      createdAt: r.created_at,
    })),
  };
}

async function collectLlmRouting(): Promise<DashboardData['llmRouting']> {
  const [total, breakdown] = await Promise.allSettled([
    db.get(
      `SELECT
         COUNT(*)::int AS total,
         ROUND(100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS success_rate
       FROM investment.llm_routing_log
       WHERE created_at > NOW() - INTERVAL '24 hours'`,
      [],
    ),
    db.query(
      `SELECT
         provider,
         COUNT(*)::int AS cnt,
         ROUND(AVG(latency_ms))::int AS avg_ms
       FROM investment.llm_routing_log
       WHERE created_at > NOW() - INTERVAL '24 hours'
       GROUP BY provider
       ORDER BY cnt DESC`,
      [],
    ),
  ]);

  return {
    totalCalls: Number((total.status === 'fulfilled' ? total.value?.total : null) || 0),
    successRate: Number((total.status === 'fulfilled' ? total.value?.success_rate : null) || 0),
    providerBreakdown: (breakdown.status === 'fulfilled' ? breakdown.value : []).map((r: any) => ({
      provider: r.provider,
      count: Number(r.cnt),
      avgMs: Number(r.avg_ms || 0),
    })),
  };
}

async function collectCrossBus(): Promise<DashboardData['crossBus']> {
  const [total, pending, agents] = await Promise.allSettled([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.agent_messages WHERE created_at > NOW() - INTERVAL '24 hours'`, []),
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.agent_messages WHERE responded_at IS NULL`, []),
    db.query(
      `SELECT to_agent AS agent, COUNT(*)::int AS pending
       FROM investment.agent_messages
       WHERE responded_at IS NULL
       GROUP BY to_agent
       ORDER BY pending DESC LIMIT 10`,
      [],
    ),
  ]);

  return {
    totalMessages: Number((total.status === 'fulfilled' ? total.value?.cnt : null) || 0),
    pendingMessages: Number((pending.status === 'fulfilled' ? pending.value?.cnt : null) || 0),
    agentActivity: (agents.status === 'fulfilled' ? agents.value : []).map((r: any) => ({
      agent: r.agent,
      pending: Number(r.pending),
    })),
  };
}

export async function collectDashboardData(): Promise<DashboardData> {
  const [l1, l2, l3, l4, retrievals, reflexions, llmRouting, crossBus] = await Promise.allSettled([
    collectLayer1Stats(),
    collectLayer2Stats(),
    collectLayer3Stats(),
    collectLayer4Stats(),
    collectAgentRetrievals(),
    collectReflexions(),
    collectLlmRouting(),
    collectCrossBus(),
  ]);

  const safe = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  return {
    generatedAt: new Date().toISOString(),
    layer1: safe(l1, { count: 0 }),
    layer2: safe(l2, { count: 0, agents: 0 }),
    layer3: safe(l3, { ragDocCount: 0, reflexionCount: 0 }),
    layer4: safe(l4, { entityFactCount: 0, skillCount: 0 }),
    agentRetrievals: safe(retrievals, LUNA_AGENTS.map(a => ({ agent: a, count: 0, lastActivity: null }))),
    reflexions: safe(reflexions, { failureCount: 0, llmFailureCount: 0, recent5: [] }),
    llmRouting: safe(llmRouting, { totalCalls: 0, successRate: 0, providerBreakdown: [] }),
    crossBus: safe(crossBus, { totalMessages: 0, pendingMessages: 0, agentActivity: [] }),
  };
}

function renderCliDashboard(data: DashboardData): string {
  const lines: string[] = [];
  const line = (s = '') => lines.push(s);
  const hr = () => line('─'.repeat(60));

  hr();
  line(`  Luna Memory Dashboard — ${data.generatedAt}`);
  hr();
  line('');
  line('  [ 4-Layer Memory 통계 ]');
  line(`    L1 Working Memory  : ${data.layer1.count}건`);
  line(`    L2 Short-Term      : ${data.layer2.count}건 (${data.layer2.agents}개 에이전트)`);
  line(`    L3 Episodic (RAG)  : ${data.layer3.ragDocCount}건`);
  line(`    L3 Reflexion       : ${data.layer3.reflexionCount}건`);
  line(`    L4 Entity Facts    : ${data.layer4.entityFactCount}건`);
  line(`    L4 Skill Library   : ${data.layer4.skillCount}건`);
  line('');
  line('  [ 에이전트별 Retrieval (7일) ]');
  for (const a of data.agentRetrievals) {
    const bar = '█'.repeat(Math.min(20, Math.max(0, Math.round(a.count / 2))));
    const lastStr = a.lastActivity ? a.lastActivity.slice(0, 19) : 'n/a';
    line(`    ${a.agent.padEnd(14)} ${String(a.count).padStart(4)}회 ${bar} (last: ${lastStr})`);
  }
  line('');
  line('  [ Reflexion 현황 ]');
  line(`    거래 실패 reflexion : ${data.reflexions.failureCount}건`);
  line(`    LLM 실패 reflexion  : ${data.reflexions.llmFailureCount}건`);
  if (data.reflexions.recent5.length > 0) {
    line('    최근 5건:');
    for (const r of data.reflexions.recent5) {
      line(`      - ${r.symbol}: ${r.hindsight}`);
    }
  }
  line('');
  line('  [ LLM Routing (24h) ]');
  line(`    총 호출 : ${data.llmRouting.totalCalls}회`);
  line(`    성공률  : ${data.llmRouting.successRate}%`);
  for (const p of data.llmRouting.providerBreakdown) {
    line(`    ${p.provider.padEnd(16)} ${p.count}회 (avg ${p.avgMs}ms)`);
  }
  line('');
  line('  [ Cross-Agent Bus (24h) ]');
  line(`    총 메시지   : ${data.crossBus.totalMessages}건`);
  line(`    미처리 대기 : ${data.crossBus.pendingMessages}건`);
  if (data.crossBus.agentActivity.length > 0) {
    line('    에이전트별 대기:');
    for (const a of data.crossBus.agentActivity) {
      line(`      ${a.agent.padEnd(14)} ${a.pending}건`);
    }
  }
  line('');
  hr();

  return lines.join('\n');
}

function renderHtmlDashboard(data: DashboardData): string {
  const escHtml = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const agentRows = data.agentRetrievals
    .map(a =>
      `<tr><td>${escHtml(a.agent)}</td><td>${a.count}</td><td>${escHtml(a.lastActivity?.slice(0, 19) ?? 'n/a')}</td></tr>`,
    )
    .join('');

  const reflexionRows = data.reflexions.recent5
    .map(r => `<tr><td>${escHtml(r.symbol)}</td><td>${escHtml(r.hindsight)}</td><td>${escHtml(String(r.createdAt || '').slice(0, 19))}</td></tr>`)
    .join('');

  const providerRows = data.llmRouting.providerBreakdown
    .map(p => `<tr><td>${escHtml(p.provider)}</td><td>${p.count}</td><td>${p.avgMs}ms</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>Luna Memory Dashboard</title>
<style>
  body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 20px; }
  h1 { color: #58a6ff; }
  h2 { color: #79c0ff; border-bottom: 1px solid #30363d; padding-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  th { background: #161b22; color: #58a6ff; padding: 6px 12px; text-align: left; }
  td { padding: 4px 12px; border-bottom: 1px solid #21262d; }
  .stat { display: inline-block; background: #161b22; border-radius: 6px; padding: 8px 16px; margin: 4px; }
  .stat-label { color: #8b949e; font-size: 0.85em; }
  .stat-value { color: #3fb950; font-size: 1.4em; font-weight: bold; }
  .ts { color: #8b949e; font-size: 0.8em; }
</style>
</head>
<body>
<h1>🧠 Luna Memory Dashboard</h1>
<p class="ts">Generated: ${escHtml(data.generatedAt)}</p>

<h2>4-Layer Memory 통계</h2>
<div>
  <div class="stat"><div class="stat-label">L1 Working</div><div class="stat-value">${data.layer1.count}</div></div>
  <div class="stat"><div class="stat-label">L2 Short-Term</div><div class="stat-value">${data.layer2.count}</div></div>
  <div class="stat"><div class="stat-label">L3 RAG Docs</div><div class="stat-value">${data.layer3.ragDocCount}</div></div>
  <div class="stat"><div class="stat-label">L3 Reflexion</div><div class="stat-value">${data.layer3.reflexionCount}</div></div>
  <div class="stat"><div class="stat-label">L4 Entity Facts</div><div class="stat-value">${data.layer4.entityFactCount}</div></div>
  <div class="stat"><div class="stat-label">L4 Skills</div><div class="stat-value">${data.layer4.skillCount}</div></div>
</div>

<h2>에이전트별 Retrieval (7일)</h2>
<table><thead><tr><th>Agent</th><th>Retrievals</th><th>Last Activity</th></tr></thead>
<tbody>${agentRows}</tbody></table>

<h2>Reflexion 현황</h2>
<table><thead><tr><th>Symbol</th><th>Hindsight</th><th>Created At</th></tr></thead>
<tbody>${reflexionRows || '<tr><td colspan="3">데이터 없음</td></tr>'}</tbody></table>

<h2>LLM Routing (24h) — 총 ${data.llmRouting.totalCalls}회, 성공률 ${data.llmRouting.successRate}%</h2>
<table><thead><tr><th>Provider</th><th>Calls</th><th>Avg Latency</th></tr></thead>
<tbody>${providerRows || '<tr><td colspan="3">데이터 없음</td></tr>'}</tbody></table>

<h2>Cross-Agent Bus (24h) — 총 ${data.crossBus.totalMessages}건, 대기 ${data.crossBus.pendingMessages}건</h2>
</body></html>`;
}

export async function runMemoryDashboard(
  opts: { format?: 'cli' | 'html'; outputPath?: string } = {},
): Promise<{ ok: boolean; data: DashboardData; output: string; outputPath?: string }> {
  const data = await collectDashboardData();
  const format = opts.format ?? (process.argv.includes('--html') ? 'html' : 'cli');
  const output = format === 'html' ? renderHtmlDashboard(data) : renderCliDashboard(data);

  let writtenPath: string | undefined;
  if (format === 'html') {
    const outDir = opts.outputPath ?? OUTPUT_PATH();
    fs.mkdirSync(outDir, { recursive: true });
    writtenPath = path.join(outDir, 'agent-memory.html');
    fs.writeFileSync(writtenPath, output, 'utf8');
  }

  return { ok: true, data, output, outputPath: writtenPath };
}

async function main() {
  if (!ENABLED() && !process.argv.includes('--force')) {
    console.log('[memory-dashboard] 비활성 (LUNA_MEMORY_DASHBOARD_HTML_ENABLED=false). --force로 강제 실행 가능.');
    return;
  }
  const result = await runMemoryDashboard();
  if (process.argv.includes('--json')) {
    const { output: _, ...rest } = result;
    console.log(JSON.stringify({ ...rest, outputPath: result.outputPath }, null, 2));
  } else {
    console.log(result.output);
    if (result.outputPath) {
      console.log(`\n📄 HTML 저장: ${result.outputPath}`);
    }
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ memory-dashboard 실패:',
  });
}
