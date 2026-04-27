#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Step = {
  id: string;
  description: string;
  command: string;
  args: string[];
  required?: boolean;
  env?: NodeJS.ProcessEnv;
};

type StepResult = {
  id: string;
  ok: boolean;
  required: boolean;
  exit_code: number;
  duration_ms: number;
  description: string;
  stdout_tail?: string[];
  stderr_tail?: string[];
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(hubRoot, '..', '..');

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function npmStep(id: string, description: string, pkg: string, script: string, extraArgs: string[] = [], required = true, env?: NodeJS.ProcessEnv): Step {
  const args = ['--prefix', pkg, 'run', '-s', script];
  if (extraArgs.length) args.push('--', ...extraArgs);
  return {
    id,
    description,
    command: 'npm',
    args,
    required,
    env,
  };
}

function tailLines(value: string, count = 12): string[] {
  return String(value || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .map((line) => line.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]'));
}

function runStep(step: Step): StepResult {
  const startedAt = Date.now();
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(step.env || {}),
    },
    maxBuffer: 1024 * 1024 * 24,
  });
  const exitCode = Number(result.status ?? 1);
  return {
    id: step.id,
    ok: exitCode === 0,
    required: step.required !== false,
    exit_code: exitCode,
    duration_ms: Date.now() - startedAt,
    description: step.description,
    stdout_tail: tailLines(String(result.stdout || '')),
    stderr_tail: tailLines(String(result.stderr || '')),
  };
}

function buildSteps(): Step[] {
  const liveLlm = hasArg('--live-llm') || flag('HUB_OPS_CLOSEOUT_LIVE_LLM');
  const archiveHome = hasArg('--archive-home') || flag('HUB_OPS_CLOSEOUT_ARCHIVE_HOME');
  const hubLiveDrillEnv = liveLlm
    ? {}
    : { HUB_LIVE_DRILL_MOCK: '1', HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN || 'hub-ops-closeout-mock-token' };

  return [
    npmStep('hub_readiness', 'Hub 자체 readiness와 secret/token redaction 상태 점검', 'bots/hub', 'readiness'),
    npmStep('oauth_team_readiness', 'Claude/OpenAI/Gemini OAuth 상태와 팀별 OAuth route coverage 점검', 'bots/hub', 'oauth:team-readiness'),
    npmStep(
      'team_llm_drill',
      liveLlm ? '팀별 Hub LLM live 호출 드릴' : '팀별 Hub LLM mock route 드릴',
      'bots/hub',
      liveLlm ? 'team:llm-drill:live' : 'team:llm-drill',
    ),
    npmStep(
      'hub_live_drill',
      liveLlm ? 'Hub HTTP live drill' : 'Hub HTTP mock drill',
      'bots/hub',
      liveLlm ? 'live:drill' : 'live:drill',
      [],
      true,
      hubLiveDrillEnv,
    ),
    npmStep('telegram_routing', 'Telegram 4개 유형 토픽 라우팅 readiness 점검', 'bots/hub', 'telegram:routing-readiness'),
    npmStep('telegram_topic_monitor', 'Telegram 팀 토픽 재생성/legacy pending 여부 점검', 'bots/hub', 'telegram:team-topic-monitor'),
    npmStep('hub_alarm_readiness', 'Hub alarm governor/digest/readiness 점검', 'bots/hub', 'alarm:readiness'),
    npmStep('retired_gateway_worktree_cleanup', '안전한 퇴역 게이트웨이 worktree cleanup 적용', 'bots/hub', 'retired-gateway:cleanup-worktrees', ['--apply']),
    npmStep(
      'retired_gateway_home_archive',
      archiveHome ? '퇴역 게이트웨이 홈 로컬 archive 생성(삭제 없음)' : '퇴역 게이트웨이 홈 archive dry-run(삭제 없음)',
      'bots/hub',
      'retired-gateway:archive-home',
      archiveHome ? ['--apply'] : [],
    ),
    npmStep('retired_gateway_cutover_readiness', '퇴역 게이트웨이 runtime blocker/cutover readiness 점검', 'bots/hub', 'retired-gateway:cutover-readiness'),
    npmStep('hub_resilience_contract', 'Hub backpressure/digest/tool guard resilience contract 점검', 'bots/hub', 'test:unit'),
    npmStep('luna_capital_l5', 'Luna capital/backpressure L5 스모크 점검', 'bots/investment', 'check:capital-l5'),
    npmStep('blog_unit_l5', 'Blog L5 unit suite 점검', 'bots/blog', 'test:unit'),
    npmStep('blog_daily_dry_run', 'Blog 일반 발행 프로세스 dry-run 점검', 'bots/blog', 'test:daily-dry'),
  ];
}

async function main(): Promise<void> {
  const steps = buildSteps();
  const results: StepResult[] = [];
  for (const step of steps) {
    const result = runStep(step);
    results.push(result);
    if (!result.ok && result.required) break;
  }

  const failedRequired = results.filter((result) => result.required && !result.ok);
  const payload = {
    ok: failedRequired.length === 0,
    generated_at: new Date().toISOString(),
    mode: {
      live_llm: hasArg('--live-llm') || flag('HUB_OPS_CLOSEOUT_LIVE_LLM'),
      archive_home_apply: hasArg('--archive-home') || flag('HUB_OPS_CLOSEOUT_ARCHIVE_HOME'),
      deletes_retired_gateway_home: false,
    },
    summary: {
      total_steps: steps.length,
      executed_steps: results.length,
      failed_required: failedRequired.length,
    },
    results,
    notes: [
      'Retired gateway home deletion is intentionally not performed by this closeout gate.',
      'Use --archive-home only to create a local archive; delete still requires the dedicated confirmation env in retired-gateway-home-archive.ts.',
      'Live LLM drill is opt-in with --live-llm to avoid accidental provider spend.',
    ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[hub-ops-closeout] failed:', error?.message || error);
  process.exit(1);
});
