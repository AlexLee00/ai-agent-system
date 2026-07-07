#!/usr/bin/env tsx
import {
  applyTokenBudgetToFallbackChain,
  ensureTokenBudgetUsageSchema,
  getTokenBudgetUsageSummary,
  recordTokenBudgetUsage,
  resolveTokenBudget,
} from '../lib/token-budget';

async function main() {
  const liveProbe = process.argv.includes('--live-probe');
  const blogBudget = resolveTokenBudget({
    callerTeam: 'blog',
    agent: 'gems',
    selectorKey: 'blog.gems.writer',
    taskType: 'daily_post_generation',
    prompt: '오늘 발행할 일반 포스팅 초안을 작성한다.'.repeat(500),
    systemPrompt: '정확한 사실만 사용하고 HTML 초안을 작성한다.',
    maxTokens: 12_000,
    timeoutMs: 900_000,
    maxBudgetUsd: 1.2,
  });

  if (!blogBudget.ok) {
    throw new Error(`blog budget should pass: ${blogBudget.reason}`);
  }
  if (blogBudget.profileName !== 'blog_long_generation') {
    throw new Error(`unexpected blog profile: ${blogBudget.profileName}`);
  }
  if (blogBudget.maxOutputTokens !== 8_000) {
    throw new Error(`blog output cap mismatch: ${blogBudget.maxOutputTokens}`);
  }
  if (blogBudget.timeoutMs !== 600_000) {
    throw new Error(`blog timeout cap mismatch: ${blogBudget.timeoutMs}`);
  }
  if (blogBudget.perAttemptTimeoutMs !== 420_000) {
    throw new Error(`blog per-attempt timeout mismatch: ${blogBudget.perAttemptTimeoutMs}`);
  }

  const alarmBudget = resolveTokenBudget({
    callerTeam: 'hub',
    agent: 'alarm-interpreter-work',
    selectorKey: 'hub.alarm.interpreter.work',
    taskType: 'alarm_interpreter',
    prompt: '알람 해석'.repeat(200),
    maxTokens: 4_000,
  });
  if (!alarmBudget.ok) {
    throw new Error(`alarm budget should pass: ${alarmBudget.reason}`);
  }
  if (alarmBudget.profileName !== 'hub_alarm_interpreter') {
    throw new Error(`unexpected alarm profile: ${alarmBudget.profileName}`);
  }

  const refactorBudget = resolveTokenBudget({
    callerTeam: 'claude',
    agent: 'refactorer',
    selectorKey: 'claude.refactorer.code_refactor',
    taskType: 'code_refactor',
    provider: 'claude-code-oauth',
    model: 'sonnet',
    prompt: 'Fix TypeScript type errors exposed by removing ts-nocheck. '.repeat(1200),
    systemPrompt: 'Return only the complete revised file content.',
    maxTokens: 8192,
    timeoutMs: 180_000,
  });
  if (!refactorBudget.ok) {
    throw new Error(`refactor budget should pass: ${refactorBudget.reason}`);
  }
  if (refactorBudget.profileName !== 'code_refactor') {
    throw new Error(`unexpected refactor profile: ${refactorBudget.profileName}`);
  }
  if (refactorBudget.maxOutputTokens !== 8192) {
    throw new Error(`refactor output cap mismatch: ${refactorBudget.maxOutputTokens}`);
  }

  const capped = applyTokenBudgetToFallbackChain([
    { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 20_000, timeoutMs: 999_000 },
    { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 20_000, timeoutMs: 999_000 },
    { provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash', maxTokens: 20_000, timeoutMs: 999_000 },
    { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 20_000, timeoutMs: 999_000 },
  ], alarmBudget);
  if (capped.length !== alarmBudget.fallbackAttempts) {
    throw new Error(`fallback attempt cap mismatch: ${capped.length}`);
  }
  if (capped.some((entry) => Number(entry.maxTokens) > alarmBudget.maxOutputTokens || Number(entry.timeoutMs) > alarmBudget.perAttemptTimeoutMs)) {
    throw new Error('fallback entry budget cap failed');
  }

  let liveRecordId: number | null = null;
  if (liveProbe) {
    await ensureTokenBudgetUsageSchema();
    const inserted = await recordTokenBudgetUsage({
      traceId: `token-budget-smoke-${Date.now()}`,
      requestId: 'token-budget-smoke',
      callerTeam: 'hub',
      agent: 'token-budget-smoke',
      taskType: 'smoke',
      selectorKey: 'hub.token_budget.smoke',
      profileName: alarmBudget.profileName,
      provider: 'dry-run',
      model: 'dry-run',
      selectedRoute: 'dry-run/token-budget',
      status: 'success',
      inputTokens: alarmBudget.inputTokens,
      maxOutputTokens: alarmBudget.maxOutputTokens,
      estimatedTotalTokens: alarmBudget.estimatedTotalTokens,
      estimatedCostUsd: alarmBudget.estimatedCostUsd,
      budgetCostUsd: alarmBudget.budgetCostUsd,
      timeoutMs: alarmBudget.timeoutMs,
      durationMs: 1,
      fallbackCount: capped.length - 1,
      attemptedProviders: capped.map((entry) => `${entry.provider}/${entry.model}`),
      promptHash: alarmBudget.promptHash,
      requestFingerprint: alarmBudget.requestFingerprint,
      metadata: { smoke: true },
    });
    liveRecordId = inserted.id;
    if (!liveRecordId) throw new Error('live token budget usage insert failed');
    const summary = await getTokenBudgetUsageSummary(10);
    const hasSmoke = summary.some((row: any) => row.agent === 'token-budget-smoke');
    if (!hasSmoke) throw new Error('live token budget usage summary missing smoke row');
  }

  console.log(JSON.stringify({
    ok: true,
    blog: {
      profile: blogBudget.profileName,
      inputTokens: blogBudget.inputTokens,
      maxOutputTokens: blogBudget.maxOutputTokens,
      timeoutMs: blogBudget.timeoutMs,
      perAttemptTimeoutMs: blogBudget.perAttemptTimeoutMs,
    },
    alarm: {
      profile: alarmBudget.profileName,
      maxOutputTokens: alarmBudget.maxOutputTokens,
      fallbackAttempts: alarmBudget.fallbackAttempts,
      cappedRoutes: capped.length,
    },
    refactor: {
      profile: refactorBudget.profileName,
      maxOutputTokens: refactorBudget.maxOutputTokens,
      budgetCostUsd: refactorBudget.budgetCostUsd,
    },
    liveRecordId,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
