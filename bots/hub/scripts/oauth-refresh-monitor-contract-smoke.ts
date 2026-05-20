#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const monitorSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/run-oauth-monitor.ts'), 'utf8');
const readinessSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/scripts/team-oauth-readiness-report.ts'), 'utf8');
const {
  buildOAuthMonitorAlarmEnvelope,
} = require('../lib/oauth/monitor-alarm-policy.ts');
const {
  selectLLMChain,
} = require('../../../packages/core/lib/llm-model-selector.ts');

for (const provider of [
  'claude-code-cli',
  'openai-codex-oauth',
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
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_OAUTH_REFRESH_HOURS'), 'Gemini CLI OAuth refresh window must be separate from alarm window');
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_OAUTH_WARN_HOURS'), 'Gemini CLI OAuth must have expiry warning thresholds');
assert.ok(monitorSource.includes('[Hub OAuth] Gemini CLI OAuth'), 'Gemini CLI OAuth must alarm on expiry/degraded refresh windows');
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_OAUTH_LIVE_PROBE_ON_EXPIRY'), 'Gemini CLI OAuth expiry monitor must keep the probe runtime-gated');
assert.ok(monitorSource.includes('runGeminiCliLiveRefreshProbeWithReimport'), 'Gemini CLI monitor must reimport refreshed CLI credentials into token-store after probe');
assert.ok(monitorSource.includes('synthetic_openai_oauth_probe_for_gemini_capacity_outage'), 'Gemini CLI monitor probe must expose the capacity-outage bypass path');
assert.ok(monitorSource.includes('capacity-bypass probe provider='), 'Gemini CLI monitor logs must identify the bypass probe provider');
assert.ok(monitorSource.includes('live_refresh_provider'), 'Gemini CLI monitor report must expose bypass probe provider');
assert.ok(monitorSource.includes('live_refresh_auth_path'), 'Gemini CLI monitor report must expose bypass auth path');
assert.ok(monitorSource.includes('HUB_GEMINI_CLI_MONITOR_PROBE_RETRIES'), 'Gemini CLI monitor must retry transient OAuth probe aborts');
assert.ok(monitorSource.includes('isTransientGeminiCliProbeError'), 'Gemini CLI monitor must classify transient probe aborts before alarming');
assert.ok(monitorSource.includes('live_refresh_attempts'), 'Gemini CLI monitor report must expose live refresh attempt count');
assert.ok(monitorSource.includes('suppressFallbackExhaustionAlarm: true'), 'Gemini CLI monitor retries must suppress inner fallback exhaustion alarms');
assert.ok(fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts'), 'utf8').includes('suppressFallbackExhaustionAlarm'), 'Unified caller must support per-request fallback exhaustion alarm suppression');
const geminiExpiryProbeChain = selectLLMChain('hub.oauth.gemini_cli.expiry_probe', {
  selectorVersion: 'v3.0_oauth_4',
});
assert.equal(geminiExpiryProbeChain[0]?.provider, 'openai-oauth', 'OAuth monitor Gemini expiry probe must bypass gemini-cli-oauth during capacity incidents');
assert.equal(
  geminiExpiryProbeChain.some((entry) => entry?.provider === 'gemini-cli-oauth'),
  false,
  'OAuth monitor Gemini expiry probe must not fall back to gemini-cli-oauth',
);
assert.ok(monitorSource.includes('post_probe_reimport_ok'), 'Gemini CLI monitor result must expose post-probe reimport status');
assert.ok(monitorSource.includes('local_credential_needs_refresh'), 'Gemini CLI OAuth monitor must distinguish stale local access token from live route failure');
assert.ok(monitorSource.includes('checkGeminiCodeAssistServiceStatus'), 'OAuth monitor must verify Gemini Code Assist service status');
assert.ok(monitorSource.includes('HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE'), 'Gemini Code Assist service readiness must be runtime-gated');
assert.ok(monitorSource.includes('gemini_codeassist_service'), 'OAuth monitor report must expose Gemini Code Assist service readiness');
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
const geminiRefreshEnvelope = buildOAuthMonitorAlarmEnvelope({
  level: 3,
  title: '[Hub OAuth] Gemini CLI OAuth 재인증/자동갱신 확인 필요',
  payload: { provider: 'gemini-cli-oauth' },
  cooldownMs: 120 * 60 * 1000,
});
assert.equal(
  geminiRefreshEnvelope.incidentKey,
  'hub:hub-oauth-monitor:hub-oauth-monitor_error:f691f557b002',
  'Gemini CLI OAuth refresh incident key must stay compatible with existing unresolved incident',
);
assert.equal(geminiRefreshEnvelope.eventType, 'hub-oauth-monitor_error', 'error envelope eventType mismatch');
assert.equal(geminiRefreshEnvelope.visibility, 'internal', 'error envelope visibility mismatch');
assert.equal(geminiRefreshEnvelope.actionability, 'auto_repair', 'error envelope actionability mismatch');
assert.equal(geminiRefreshEnvelope.dedupeMinutes, 120, 'producer cooldown must be propagated as dedupeMinutes');
const geminiCodeAssistReauthEnvelope = buildOAuthMonitorAlarmEnvelope({
  level: 3,
  title: '[Hub OAuth] Gemini Code Assist 재인증 필요',
  payload: {
    provider: 'gemini-cli-oauth',
    service: 'cloudaicompanion.googleapis.com',
    error: {
      kind: 'auth_required',
      status: 401,
      google_status: 'UNAUTHENTICATED',
    },
    manual_reauth_required: true,
  },
  cooldownMs: 120 * 60 * 1000,
});
assert.equal(
  geminiCodeAssistReauthEnvelope.incidentKey,
  'hub:hub-oauth-monitor:hub-oauth-monitor_error:545330eba13b',
  'Gemini Code Assist auth-required incident key must stay compatible with existing unresolved incident',
);
assert.equal(geminiCodeAssistReauthEnvelope.visibility, 'human_action', 'manual reauth must route to human action visibility');
assert.equal(geminiCodeAssistReauthEnvelope.actionability, 'needs_human', 'manual reauth must not route to auto repair');
assert.equal(geminiCodeAssistReauthEnvelope.dedupeMinutes, 120, 'manual reauth cooldown must be propagated');
const oauthFlowSource = fs.readFileSync(path.join(repoRoot, 'bots/hub/lib/oauth/oauth-flow.ts'), 'utf8');
assert.ok(oauthFlowSource.includes('app_EMoamEEZ73f0CkXaXp7hrann'), 'OpenAI Codex OAuth refresh must use the public Codex-compatible client id by default');
assert.ok(oauthFlowSource.includes('refreshIncludesScope: false'), 'OpenAI Codex OAuth refresh must match Codex-compatible refresh grant and omit scope');
assert.ok(monitorSource.includes('postAlarm'), 'OAuth monitor must alarm on refresh/unhealthy failures');
assert.ok(readinessSource.includes('expires_in_hours'), 'team readiness report must include token expiry windows');
assert.ok(readinessSource.includes('needs_refresh'), 'team readiness report must include refresh-needed flags');

console.log(JSON.stringify({
  ok: true,
  providers: 3,
  refresh_contract: 'token-store refresh plus local sync plus alarm',
}));
