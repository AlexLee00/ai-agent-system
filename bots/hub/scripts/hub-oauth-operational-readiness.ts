#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type StepResult = {
  id: string;
  ok: boolean;
  required: boolean;
  exit_code: number;
  parsed: any;
  error: string | null;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(hubRoot, '..', '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function parseJsonFromOutput(value: string): any {
  const text = String(value || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function runScript(id: string, script: string, args: string[] = [], options: { required?: boolean; env?: NodeJS.ProcessEnv } = {}): StepResult {
  const result = spawnSync(tsxBin, [path.join(scriptDir, script), ...args], {
    cwd: hubRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    maxBuffer: 1024 * 1024 * 12,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const parsed = parseJsonFromOutput(output);
  const exitCode = Number(result.status ?? 1);
  return {
    id,
    ok: exitCode === 0,
    required: options.required !== false,
    exit_code: exitCode,
    parsed,
    error: exitCode === 0 ? null : String(result.stderr || result.stdout || result.error?.message || 'step_failed').trim().slice(0, 400),
  };
}

function providerSummary(teamReadiness: any) {
  const providers = teamReadiness?.providers || {};
  return {
    claude_code_oauth: {
      healthy: Boolean(providers.claude_code_oauth?.healthy),
      needs_refresh: Boolean(providers.claude_code_oauth?.needs_refresh),
      expires_in_hours: providers.claude_code_oauth?.expires_in_hours ?? null,
    },
    openai_oauth: {
      healthy: Boolean(providers.openai_oauth?.healthy),
      needs_refresh: Boolean(providers.openai_oauth?.needs_refresh),
      expires_in_hours: providers.openai_oauth?.expires_in_hours ?? null,
    },
    gemini_cli_oauth: {
      required_by_team: Boolean(providers.gemini_cli_oauth?.required_by_team),
      healthy: Boolean(providers.gemini_cli_oauth?.healthy),
      quota_project_configured: Boolean(providers.gemini_cli_oauth?.quota_project_configured),
      needs_cli_refresh: Boolean(providers.gemini_cli_oauth?.needs_cli_refresh),
      expires_in_hours: providers.gemini_cli_oauth?.expires_in_hours ?? null,
    },
    gemini_public_api: {
      enabled: Boolean(providers.gemini_oauth?.enabled),
      required_by_team: Boolean(providers.gemini_oauth?.required_by_team),
      healthy: Boolean(providers.gemini_oauth?.healthy),
      quota_project_configured: Boolean(providers.gemini_oauth?.quota_project_configured),
    },
  };
}

function main(): void {
  const requireGeminiQuotaProject = flag('HUB_OAUTH_OPS_REQUIRE_GEMINI_QUOTA_PROJECT');
  const liveSteward = flag('HUB_OAUTH_OPS_LIVE_STEWARD_DRILL');

  const steps = [
    runScript('team_oauth_readiness', 'team-oauth-readiness-report.ts'),
    runScript('gemini_cli_readiness', 'gemini-cli-oauth-readiness.ts', ['--json', ...(requireGeminiQuotaProject ? ['--require-project'] : [])], {
      required: requireGeminiQuotaProject,
    }),
    runScript('team_llm_route_drill_mock', 'team-llm-route-drill.ts'),
    runScript(
      liveSteward ? 'steward_gemini_drill_live' : 'steward_gemini_drill_mock',
      'steward-gemini-model-drill.ts',
      ['--json', ...(liveSteward ? [] : ['--mock'])],
      {
        required: liveSteward,
        env: liveSteward ? {} : { HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN || 'steward-gemini-drill-mock-token' },
      },
    ),
  ];

  const teamReadiness = steps.find((step) => step.id === 'team_oauth_readiness')?.parsed;
  const geminiCliReadiness = steps.find((step) => step.id === 'gemini_cli_readiness')?.parsed;
  const stewardDrill = steps.find((step) => step.id.startsWith('steward_gemini_drill'))?.parsed;
  const failedRequired = steps.filter((step) => step.required && !step.ok);
  const provider = providerSummary(teamReadiness);
  const geminiQuotaMissing = provider.gemini_cli_oauth.required_by_team
    && !provider.gemini_cli_oauth.quota_project_configured;
  const ok = failedRequired.length === 0
    && provider.claude_code_oauth.healthy
    && provider.openai_oauth.healthy
    && provider.gemini_cli_oauth.healthy
    && (!requireGeminiQuotaProject || !geminiQuotaMissing)
    && (stewardDrill?.ok !== false);

  const payload = {
    ok,
    generated_at: new Date().toISOString(),
    mode: {
      live_steward_drill: liveSteward,
      require_gemini_quota_project: requireGeminiQuotaProject,
      public_api_tokens_are_optional: true,
    },
    providers: provider,
    gemini_cli_readiness: {
      ok: Boolean(geminiCliReadiness?.ok),
      command_ok: Boolean(geminiCliReadiness?.command?.ok),
      credentials_ok: Boolean(geminiCliReadiness?.credentials?.ok),
      quota_project_configured: Boolean(geminiCliReadiness?.credentials?.quota_project_configured),
      live_requested: Boolean(geminiCliReadiness?.live_requested),
      live_ok: geminiCliReadiness?.live?.ok ?? null,
      warnings: geminiCliReadiness?.warnings || [],
    },
    steward_gemini: {
      ok: Boolean(stewardDrill?.ok),
      mode: stewardDrill?.mode || null,
      required_count: Number(stewardDrill?.requiredCount || 0),
      optional_count: Number(stewardDrill?.optionalCount || 0),
      max_wall_ms: stewardDrill?.latency?.maxWallMs ?? null,
      routes: Array.isArray(stewardDrill?.results)
        ? stewardDrill.results.map((item: any) => ({
          name: item.name,
          ok: Boolean(item.ok),
          provider: item.provider || null,
          selected_route: item.selectedRoute || null,
          wall_ms: item.wallMs ?? null,
        }))
        : [],
    },
    steps: steps.map((step) => ({
      id: step.id,
      ok: step.ok,
      required: step.required,
      exit_code: step.exit_code,
      error: step.error,
    })),
    next_actions: [
      ...(geminiQuotaMissing ? ['Set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT if direct Gemini API/pro quota attribution is required.'] : []),
      ...(provider.claude_code_oauth.needs_refresh ? ['Run Claude Code browser re-auth before token expiry if refresh/import does not recover automatically.'] : []),
      ...(provider.openai_oauth.needs_refresh ? ['Run Codex/OpenAI OAuth re-auth before token expiry if refresh/import does not recover automatically.'] : []),
      ...(provider.gemini_cli_oauth.needs_cli_refresh ? ['Run npm --prefix bots/hub run -s oauth:gemini-cli-readiness -- --live to verify Gemini CLI refresh path; re-run gemini auth login only if live probe fails.'] : []),
      ...(liveSteward ? [] : ['Run HUB_OAUTH_OPS_LIVE_STEWARD_DRILL=1 npm --prefix bots/hub run -s oauth:ops-readiness for live Steward latency verification.']),
    ],
    notes: [
      'No provider token, account id, chat id, or raw secret is included in this report.',
      'Gemini public API remains optional; gemini-cli-oauth is the default local OAuth boundary for Steward/Jay summary routing.',
    ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = ok ? 0 : 1;
}

main();
