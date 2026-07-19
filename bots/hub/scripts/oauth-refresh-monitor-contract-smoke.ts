#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const monitorSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/run-oauth-monitor.ts'), 'utf8');
const readinessSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/team-oauth-readiness-report.ts'), 'utf8');
const liveCanarySource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/llm-stage-a-live-canary.ts'), 'utf8');
const {
  buildOAuthMonitorAlarmEnvelope,
} = require('../lib/oauth/monitor-alarm-policy.ts');

for (const provider of [
  'claude-code-cli',
  'openai-codex-oauth',
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
]) {
  assert.ok(monitorSource.includes(`async function ${fn}`), `oauth monitor missing ${fn}`);
}

assert.ok(monitorSource.includes('writeClaudeCodeLocalCredentials'), 'Claude refresh must sync back to ~/.claude runtime credentials');
assert.ok(monitorSource.includes('writeClaudeCodeKeychainCredentials'), 'Claude refresh should also support Keychain sync when explicitly allowed');
assert.ok(monitorSource.includes('runClaudeCodeLiveProbe'), 'Claude monitor must verify the real Claude Code CLI call path');
assert.ok(monitorSource.includes('HUB_CLAUDE_CODE_LIVE_PROBE_ON_MONITOR'), 'Claude live probe must be runtime-gated');
assert.ok(monitorSource.includes('writeOpenAiCodexLocalCredentials'), 'OpenAI refresh must sync back to local Codex credentials');
assert.ok(monitorSource.includes('withOAuthRefreshLock'), 'OAuth monitor must serialize refresh/reimport with a provider lock');
assert.ok(monitorSource.includes('withMonitorOAuthLock'), 'OAuth monitor must fail closed on refresh lock timeout/contention');
assert.ok(monitorSource.includes('HUB_CLAUDE_OAUTH_REFRESH_HOURS'), 'Claude OAuth refresh window must be separate from alarm window');
assert.ok(monitorSource.includes('HUB_OPENAI_OAUTH_REFRESH_HOURS'), 'OpenAI OAuth refresh window must be separate from alarm window');
assert.ok(monitorSource.includes('finiteNumberOrNull'), 'OAuth monitor reports must not coerce null numeric fields to zero');
assert.ok(liveCanarySource.includes('suppressFallbackExhaustionAlarm: true'), 'Hub live canaries must not emit production fallback exhaustion alarms');
assert.ok(fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts'), 'utf8').includes('suppressFallbackExhaustionAlarm'), 'Unified caller must support per-request fallback exhaustion alarm suppression');
assert.ok(monitorSource.includes('getGeminiRetirementState'), 'OAuth monitor must use the immutable Gemini retirement policy');
assert.ok(monitorSource.includes('if (geminiLlmDisabled())'), 'Gemini compatibility checks must fail closed before credential or network access');
assert.ok(monitorSource.includes("geminiMonitorDisabledResult('retired_provider')"), 'Gemini CLI compatibility result must identify provider retirement');
assert.ok(monitorSource.includes("error: 'gemini_provider_disabled'"), 'Gemini Code Assist compatibility result must identify provider retirement');
assert.ok(!monitorSource.includes('checkGeminiOAuth()'), 'retired gemini-oauth must not run in oauth monitor');
assert.ok(!monitorSource.includes('gemini_oauth:'), 'oauth monitor report must not expose retired gemini_oauth status');
assert.ok(monitorSource.includes('normalizeOAuthAlarmPayload'), 'OAuth monitor must normalize alarm payload before cooldown/postAlarm routing');
assert.ok(monitorSource.includes('isRetiredGeminiOAuthAlarm'), 'retired gemini-oauth alarms must be suppressed at the alarm boundary');
assert.ok(monitorSource.includes('normalizedPayload'), 'OAuth alarm suppression must use normalizedPayload to avoid provider alias divergence');
assert.ok(monitorSource.includes('HUB_OAUTH_MONITOR_REAUTH_ALARM_COOLDOWN_MINUTES'), 'healthy reauth alarms must use a longer dedicated cooldown');
assert.ok(monitorSource.includes('refresh_config_missing'), 'OpenAI Codex OAuth alarms must expose missing refresh configuration');
assert.ok(monitorSource.includes('buildOAuthMonitorAlarmEnvelope'), 'OAuth monitor must build an explicit Hub alarm envelope');
assert.ok(monitorSource.includes('incidentKey: envelope.incidentKey'), 'OAuth monitor must pass a stable incidentKey to postAlarm');
assert.ok(monitorSource.includes('eventType: envelope.eventType'), 'OAuth monitor must pass explicit eventType to postAlarm');
assert.ok(monitorSource.includes('dedupeMinutes: envelope.dedupeMinutes'), 'OAuth monitor must propagate producer cooldown to Hub dedupe');
assert.ok(monitorSource.includes('actionability: envelope.actionability'), 'OAuth monitor must preserve auto-repair actionability');
const claudeCoveredNearExpiryEnvelope = buildOAuthMonitorAlarmEnvelope({
  level: 3,
  title: '[Hub OAuth] Claude Code OAuth 재인증 예정',
  payload: {
    provider: 'claude-code-oauth',
    healthy: true,
    needs_refresh: true,
    expires_in_hours: 1,
    refresh: {
      ok: false,
      error: 'Refresh token not found or invalid',
      details: { status: 400 },
    },
    reimport: {
      ok: true,
      source: 'claude_keychain',
      expires_in_hours: 0.95,
    },
    live_probe: {
      ok: true,
      latency_ms: 3414,
      session_id_present: true,
    },
  },
  cooldownMs: 120 * 60 * 1000,
});
assert.equal(claudeCoveredNearExpiryEnvelope.eventType, 'hub-oauth-monitor_work', 'covered Claude near-expiry must not become an auto-repair error');
assert.equal(claudeCoveredNearExpiryEnvelope.visibility, 'digest', 'covered Claude near-expiry should be digest visibility');
assert.equal(claudeCoveredNearExpiryEnvelope.actionability, 'none', 'covered Claude near-expiry should not enqueue auto_dev repair');
const claudeProbeOnlyNearExpiryEnvelope = buildOAuthMonitorAlarmEnvelope({
  level: 3,
  title: '[Hub OAuth] Claude Code OAuth 재인증 예정',
  payload: {
    provider: 'claude-code-oauth',
    healthy: true,
    needs_refresh: true,
    expires_in_hours: 1,
    refresh: {
      ok: false,
      error: 'Refresh token not found or invalid',
      details: { status: 400 },
    },
    reimport: {
      ok: false,
      source: 'claude_keychain',
      expires_in_hours: 0.95,
    },
    live_probe: {
      ok: true,
      latency_ms: 3414,
      session_id_present: true,
    },
  },
  cooldownMs: 120 * 60 * 1000,
});
assert.equal(claudeProbeOnlyNearExpiryEnvelope.eventType, 'hub-oauth-monitor_error', 'live probe alone must not cover a near-expiry refresh failure');
assert.equal(claudeProbeOnlyNearExpiryEnvelope.actionability, 'auto_repair', 'live probe alone should keep near-expiry refresh failure actionable');
const oauthFlowSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/oauth/oauth-flow.ts'), 'utf8');
assert.ok(oauthFlowSource.includes('app_EMoamEEZ73f0CkXaXp7hrann'), 'OpenAI Codex OAuth refresh must use the public Codex-compatible client id by default');
assert.ok(oauthFlowSource.includes('refreshIncludesScope: false'), 'OpenAI Codex OAuth refresh must match Codex-compatible refresh grant and omit scope');
assert.ok(monitorSource.includes('postAlarm'), 'OAuth monitor must alarm on refresh/unhealthy failures');
assert.ok(readinessSource.includes('expires_in_hours'), 'team readiness report must include token expiry windows');
assert.ok(readinessSource.includes('needs_refresh'), 'team readiness report must include refresh-needed flags');

console.log(JSON.stringify({
  ok: true,
  providers: 2,
  refresh_contract: 'OpenAI and Claude refresh plus retired Gemini skip',
}));
