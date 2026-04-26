import * as assert from 'node:assert/strict';

const config = require('../../../bots/orchestrator/lib/openclaw-config.ts');

function withEnvPatch(patch: Record<string, string | null>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertRetiredWriteBlocked(label: string, fn: () => unknown): void {
  assert.throws(
    fn,
    /retired.*HUB_ALLOW_OPENCLAW_LEGACY_ADMIN=1/i,
    `${label} must be fail-closed unless explicitly enabled`,
  );
}

function main(): void {
  withEnvPatch({ HUB_ALLOW_OPENCLAW_LEGACY_ADMIN: null }, () => {
    assert.equal(config.isLegacyOpenClawAdminEnabled(), false);
    assertRetiredWriteBlocked('update primary', () => config.updateOpenClawGatewayPrimary('provider/model'));
    assertRetiredWriteBlocked('update fallbacks', () => config.updateOpenClawGatewayFallbacks(['provider/model']));
    assertRetiredWriteBlocked('update concurrency', () => config.updateOpenClawGatewayConcurrency({
      maxConcurrent: 1,
      subagentMaxConcurrent: 1,
    }));
    assertRetiredWriteBlocked('normalize sessions', () => config.normalizeOpenClawMainIngressSessions({
      sessionsPath: '/tmp/nonexistent-openclaw-sessions.json',
    }));
  });

  withEnvPatch({ HUB_ALLOW_OPENCLAW_LEGACY_ADMIN: '1' }, () => {
    assert.equal(config.isLegacyOpenClawAdminEnabled(), true);
  });

  console.log(JSON.stringify({
    ok: true,
    legacy_openclaw_admin_default_blocked: true,
    explicit_break_glass_flag_required: 'HUB_ALLOW_OPENCLAW_LEGACY_ADMIN=1',
  }));
}

main();
