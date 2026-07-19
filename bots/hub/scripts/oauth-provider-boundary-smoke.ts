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

  assertIncludes(readiness, 'isGeminiDisabled()', 'team OAuth readiness retirement guard');
  assertIncludes(drill, 'getGeminiRetirementState', 'team LLM drill retirement guard');
  assertIncludes(monitor, 'getGeminiRetirementState', 'OAuth monitor retirement policy');
  assertIncludes(monitor, "geminiMonitorDisabledResult('retired_provider')", 'OAuth monitor retired Gemini result');

  assertIncludes(hubClaude, 'ANTHROPIC_AUTH_TOKEN', 'Hub Claude Code child env scrub');
  assertIncludes(hubClaude, 'delete childEnv[key]', 'Hub Claude Code child env scrub');
  assertIncludes(coreFallback, 'CLAUDE_CODE_AUTH_ENV_KEYS', 'Core Claude Code child env scrub');
  assertIncludes(coreFallback, 'assertProviderNotRetired(provider);', 'Core retired-provider execution guard');
  assertIncludes(coreFallback, 'assertProviderNotRetired(model);', 'Core retired-model execution guard');

  assertIncludes(oauthFlowTest, 'atomically rotates refresh token', 'OpenAI Codex refresh regression');
  assertIncludes(oauthFlowTest, 'rotated-refresh-token', 'OpenAI Codex refresh regression');

  console.log(JSON.stringify({
    ok: true,
    checked: [
      'gemini_provider_retirement_guard',
      'claude_code_cli_token_boundary',
      'openai_codex_refresh_token_rotation',
    ],
  }));
}

main().catch((error) => {
  console.error('[oauth-provider-boundary-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
