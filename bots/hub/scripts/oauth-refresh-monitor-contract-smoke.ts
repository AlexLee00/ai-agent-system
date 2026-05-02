#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const monitorSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/run-oauth-monitor.ts'), 'utf8');
const readinessSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/team-oauth-readiness-report.ts'), 'utf8');

for (const provider of [
  'claude-code-cli',
  'openai-codex-oauth',
  'gemini-oauth',
  'gemini-cli-oauth',
]) {
  assert.ok(
    monitorSource.includes(`getProviderRecord('${provider}')`) || monitorSource.includes(`setProviderToken('${provider}'`),
    `oauth monitor must manage token-store record for ${provider}`,
  );
  assert.ok(
    readinessSource.includes(`getProviderRecord('${provider}')`) || provider === 'claude-code-cli',
    `team oauth readiness must expose expiry window for ${provider}`,
  );
}

for (const fn of [
  'refreshClaudeCodeHubToken',
  'refreshOpenAiCodexHubToken',
  'refreshGeminiOAuthHubToken',
]) {
  assert.ok(monitorSource.includes(`async function ${fn}`), `oauth monitor missing ${fn}`);
}

assert.ok(monitorSource.includes('writeClaudeCodeKeychainCredentials'), 'Claude refresh must sync back to local Claude Code credentials');
assert.ok(monitorSource.includes('writeOpenAiCodexLocalCredentials'), 'OpenAI refresh must sync back to local Codex credentials');
assert.ok(monitorSource.includes('withOAuthRefreshLock'), 'OAuth monitor must serialize refresh/reimport with a provider lock');
assert.ok(monitorSource.includes('withMonitorOAuthLock'), 'OAuth monitor must fail closed on refresh lock timeout/contention');
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_OAUTH_WARN_HOURS'), 'Gemini CLI OAuth must have expiry warning thresholds');
assert.ok(monitorSource.includes('[Hub OAuth] Gemini CLI OAuth'), 'Gemini CLI OAuth must alarm on expiry/degraded refresh windows');
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_OAUTH_LIVE_PROBE_ON_EXPIRY'), 'Gemini CLI OAuth expiry monitor must verify live CLI refresh before alarming');
assert.ok(monitorSource.includes('runGeminiCliLiveRefreshProbeWithReimport'), 'Gemini CLI live refresh probe must reimport refreshed CLI credentials into token-store');
assert.ok(monitorSource.includes('post_probe_reimport_ok'), 'Gemini CLI monitor result must expose post-probe reimport status');
assert.ok(monitorSource.includes('local_credential_needs_refresh'), 'Gemini CLI OAuth monitor must distinguish stale local access token from live route failure');
assert.ok(monitorSource.includes('postAlarm'), 'OAuth monitor must alarm on refresh/unhealthy failures');
assert.ok(readinessSource.includes('expires_in_hours'), 'team readiness report must include token expiry windows');
assert.ok(readinessSource.includes('needs_refresh'), 'team readiness report must include refresh-needed flags');

console.log(JSON.stringify({
  ok: true,
  providers: 4,
  refresh_contract: 'token-store refresh plus local sync plus alarm',
}));
