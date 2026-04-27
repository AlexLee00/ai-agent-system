#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertIncludes(source, needle, label) {
  assert(
    source.includes(needle),
    `${label} must include ${needle}`,
  );
}

async function main() {
  const readiness = read('bots/hub/scripts/team-oauth-readiness-report.ts');
  const drill = read('bots/hub/scripts/team-llm-route-drill.ts');
  const monitor = read('bots/hub/scripts/run-oauth-monitor.ts');
  const hubClaude = read('bots/hub/lib/llm/claude-code-oauth.ts');
  const coreFallback = read('packages/core/lib/llm-fallback.ts');
  const oauthFlowTest = read('bots/hub/__tests__/oauth-flow.test.ts');

  assertIncludes(readiness, "normalized.startsWith('gemini-cli-oauth/')", 'team OAuth readiness');
  assertIncludes(readiness, 'gemini_cli_oauth', 'team OAuth readiness report');
  assertIncludes(drill, "normalized.startsWith('gemini-cli-oauth/')", 'team LLM drill');
  assertIncludes(drill, "'gemini-cli-oauth'", 'team LLM drill OAuth provider list');

  assertIncludes(monitor, 'async function checkGeminiCliOAuth()', 'OAuth monitor');
  assertIncludes(monitor, "setProviderToken('gemini-cli-oauth'", 'OAuth monitor Gemini CLI sync');

  assertIncludes(hubClaude, 'ANTHROPIC_AUTH_TOKEN', 'Hub Claude Code child env scrub');
  assertIncludes(hubClaude, 'delete childEnv[key]', 'Hub Claude Code child env scrub');
  assertIncludes(coreFallback, 'CLAUDE_CODE_AUTH_ENV_KEYS', 'Core Claude Code child env scrub');
  assertIncludes(coreFallback, 'GEMINI_CLI_PUBLIC_API_ENV_KEYS', 'Core Gemini CLI child env scrub');
  assertIncludes(coreFallback, "case 'gemini-cli-oauth'", 'Core fallback Gemini CLI provider');

  assertIncludes(oauthFlowTest, 'atomically rotates refresh token', 'OpenAI Codex refresh regression');
  assertIncludes(oauthFlowTest, 'rotated-refresh-token', 'OpenAI Codex refresh regression');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'gemini_cli_oauth_readiness',
      'gemini_cli_oauth_team_drill',
      'gemini_cli_oauth_monitor_sync',
      'claude_code_cli_token_boundary',
      'openai_codex_refresh_token_rotation',
    ],
  }));
}

main().catch((error) => {
  console.error('[oauth-provider-boundary-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
