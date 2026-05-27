// @ts-nocheck
'use strict';

// Week 2 Day 10: Langfuse 100 trace 발생 + 통계 검증 스크립트
// 실행:
//   tsx bots/hub/scripts/langfuse-trace-validation.ts
//   tsx bots/hub/scripts/langfuse-trace-validation.ts --count=50 --json

import path from 'node:path';
import fs from 'node:fs';
const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function loadLangfuseEnvFromDockerInit(): void {
  const envPath = path.join(PROJECT_ROOT, 'docker/.env.langfuse');
  if (!fs.existsSync(envPath)) return;
  const parsed: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/u)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    parsed[key.trim()] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  if (!process.env.LANGFUSE_HOST && parsed.LANGFUSE_HOST) process.env.LANGFUSE_HOST = parsed.LANGFUSE_HOST;
  if (!process.env.LANGFUSE_PUBLIC_KEY && parsed.LANGFUSE_INIT_PROJECT_PUBLIC_KEY) process.env.LANGFUSE_PUBLIC_KEY = parsed.LANGFUSE_INIT_PROJECT_PUBLIC_KEY;
  if (!process.env.LANGFUSE_SECRET_KEY && parsed.LANGFUSE_INIT_PROJECT_SECRET_KEY) process.env.LANGFUSE_SECRET_KEY = parsed.LANGFUSE_INIT_PROJECT_SECRET_KEY;
  if (!process.env.LANGFUSE_ENABLED && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) process.env.LANGFUSE_ENABLED = 'true';
}

const PROVIDERS = ['anthropic', 'openai', 'groq', 'local'];
const TASK_TYPES = ['reasoning', 'generation', 'classification', 'summary'];
const TEAMS = ['luna', 'sigma', 'darwin', 'claude', 'blo'];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface TraceStats {
  total: number;
  byProvider: Record<string, number>;
  byTeam: Record<string, number>;
  byTaskType: Record<string, number>;
  avgDurationMs: number;
  totalCostUsd: number;
}

interface ValidationResult {
  ok: boolean;
  ts: string;
  traceCount: number;
  targetCount: number;
  flushOk: boolean;
  apiVisibleCount: number | null;
  apiVerificationError: string | null;
  stats: TraceStats;
  message: string;
}

export async function runLangfuseTraceValidation(options: { count?: number } = {}): Promise<ValidationResult> {
  loadLangfuseEnvFromDockerInit();
  const langfuseTracer = require(path.join(PROJECT_ROOT, 'bots/hub/lib/langfuse-tracer'));

  const targetCount = options.count ?? parseInt(argValue('count', '100'), 10);
  const visibilityWaitMs = parseInt(argValue('visibility-wait-ms', '30000'), 10);
  const configured = ['true', '1', 'yes'].includes(String(process.env.LANGFUSE_ENABLED || '').toLowerCase())
    && process.env.LANGFUSE_PUBLIC_KEY
    && process.env.LANGFUSE_SECRET_KEY;
  if (!configured) {
    return {
      ok: false,
      ts: new Date().toISOString(),
      traceCount: 0,
      targetCount,
      flushOk: false,
      apiVisibleCount: null,
      apiVerificationError: null,
      stats: { total: 0, byProvider: {}, byTeam: {}, byTaskType: {}, avgDurationMs: 0, totalCostUsd: 0 },
      message: 'Langfuse key/env 미설정 - docker/.env.langfuse 또는 launchctl env 확인 필요',
    };
  }
  const stats: TraceStats = {
    total: 0,
    byProvider: {},
    byTeam: {},
    byTaskType: {},
    avgDurationMs: 0,
    totalCostUsd: 0,
  };

  const durations: number[] = [];

  for (let i = 0; i < targetCount; i++) {
    const provider = pickRandom(PROVIDERS);
    const team = pickRandom(TEAMS);
    const taskType = pickRandom(TASK_TYPES);
    const durationMs = Math.floor(Math.random() * 2000) + 100;
    const costUsd = provider === 'local' ? 0 : Math.random() * 0.01;

    langfuseTracer.traceLLMCall(
      { prompt: `trace-validation test ${i}`, systemPrompt: 'you are a test agent' },
      { ok: true, provider, selected_route: provider, durationMs, totalCostUsd: costUsd, cacheHit: i % 10 === 0 },
      { agent: `test-agent-${i % 5}`, callerTeam: team, taskType, autoRouted: i % 3 === 0 },
    );

    stats.total++;
    stats.byProvider[provider] = (stats.byProvider[provider] || 0) + 1;
    stats.byTeam[team] = (stats.byTeam[team] || 0) + 1;
    stats.byTaskType[taskType] = (stats.byTaskType[taskType] || 0) + 1;
    stats.totalCostUsd += costUsd;
    durations.push(durationMs);
  }

  stats.avgDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;

  // 5초 대기 후 flush (flushInterval: 5000ms)
  let flushOk = false;
  try {
    if (typeof langfuseTracer.flushLangfuse === 'function') {
      await Promise.race([
        new Promise((res) => setTimeout(res, 5500)).then(() => langfuseTracer.flushLangfuse()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('flush timeout 10s')), 10000)),
      ]);
      flushOk = true;
    } else {
      await new Promise((res) => setTimeout(res, 5500));
      flushOk = true;
    }
  } catch (_) {
    flushOk = false;
  }

  let apiVisibleCount: number | null = null;
  let apiVerificationError: string | null = null;
  try {
    const { Langfuse } = require('langfuse');
    const client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_HOST || 'http://localhost:3000',
    });
    const deadline = Date.now() + Math.max(0, visibilityWaitMs);
    do {
      const listed = await client.api.traceList({
        limit: Math.min(100, targetCount),
        name: 'llm_call',
        fromTimestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
        orderBy: 'timestamp.desc',
      });
      apiVisibleCount = Number(listed?.meta?.totalItems ?? listed?.data?.length ?? 0);
      if (apiVisibleCount > 0 || Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, 2000));
    } while (true);
  } catch (error) {
    apiVisibleCount = null;
    apiVerificationError = String(error?.message || error);
  }

  const ok = stats.total === targetCount && flushOk && apiVisibleCount !== null && apiVisibleCount > 0;

  const message = [
    `trace 발송: ${stats.total}/${targetCount} ${ok ? '✅' : '❌'}`,
    `flush (5s 후): ${flushOk ? '✅' : '⚠️ 비동기 처리 중'}`,
    `API visible traces: ${apiVisibleCount == null ? `not_verified (${apiVerificationError || 'unknown error'})` : apiVisibleCount}`,
    `Provider 분포: ${JSON.stringify(stats.byProvider)}`,
    `Team 분포: ${JSON.stringify(stats.byTeam)}`,
    `평균 latency: ${stats.avgDurationMs.toFixed(0)}ms`,
    `총 비용: $${stats.totalCostUsd.toFixed(4)}`,
  ].join('\n');

  return { ok, ts: new Date().toISOString(), traceCount: stats.total, targetCount, flushOk, apiVisibleCount, apiVerificationError, stats, message };
}

async function main() {
  const count = parseInt(argValue('count', '100'), 10);
  console.log(`[langfuse-trace-validation] ${count}개 trace 발생 + 검증 시작...`);
  const result = await runLangfuseTraceValidation({ count });
  console.log('[langfuse-trace-validation] 결과:');
  console.log(result.message);
  if (result.ok) {
    console.log('\n[langfuse-trace-validation] ✅ Langfuse trace 검증 완료!');
    console.log('Langfuse UI (http://localhost:3000) 에서 trace 확인 가능.');
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[langfuse-trace-validation] 오류:', err?.message || err);
    process.exit(1);
  });
}
