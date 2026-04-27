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
assert.ok(monitorSource.includes('postAlarm'), 'OAuth monitor must alarm on refresh/unhealthy failures');
assert.ok(readinessSource.includes('expires_in_hours'), 'team readiness report must include token expiry windows');
assert.ok(readinessSource.includes('needs_refresh'), 'team readiness report must include refresh-needed flags');

console.log(JSON.stringify({
  ok: true,
  providers: 3,
  refresh_contract: 'token-store refresh plus local sync plus alarm',
}));
