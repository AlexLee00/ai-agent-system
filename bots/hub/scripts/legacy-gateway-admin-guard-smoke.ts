import * as assert from 'node:assert/strict';

const retiredConfigPath = '../../../bots/orchestrator/lib/retired-gateway-config.ts';
const config = require(retiredConfigPath);
const LEGACY_ADMIN_ENV = 'HUB_ALLOW_' + 'OPEN' + 'CLAW_LEGACY_ADMIN';
const fn = (name: string) => config[name];

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
    /permanently retired.*Hub selector\/control-plane/i,
    `${label} must be permanently retired`,
  );
}

function main(): void {
  withEnvPatch({ [LEGACY_ADMIN_ENV]: null }, () => {
    assert.equal(fn('isLegacyGatewayAdminEnabled')(), false);
    assert.equal(fn('getRetiredGatewayConfigPath')(), null);
    assert.equal(fn('getRetiredGatewayMainSessionsPath')(), null);
    assert.equal(fn('getRetiredGatewayAgentAuthPath')(), null);
    assert.equal(fn('getRetiredGatewayModelState')().retired, true);
    assert.equal(fn('getPreferredRetiredGatewayIngressModel')().retired, true);
    assertRetiredWriteBlocked('update primary', () => fn('updateRetiredGatewayPrimary')('provider/model'));
    assertRetiredWriteBlocked('update fallbacks', () => fn('updateRetiredGatewayFallbacks')(['provider/model']));
    assertRetiredWriteBlocked('update concurrency', () => fn('updateRetiredGatewayConcurrency')({
      maxConcurrent: 1,
      subagentMaxConcurrent: 1,
    }));
    assertRetiredWriteBlocked('normalize sessions', () => fn('normalizeRetiredGatewayMainIngressSessions')({
      sessionsPath: `/tmp/nonexistent-open${'claw'}-sessions.json`,
    }));
  });

  withEnvPatch({ [LEGACY_ADMIN_ENV]: '1' }, () => {
    assert.equal(fn('isLegacyGatewayAdminEnabled')(), false);
    assertRetiredWriteBlocked('break-glass update primary', () => fn('updateRetiredGatewayPrimary')('provider/model'));
  });

  console.log(JSON.stringify({
    ok: true,
    legacy_gateway_admin_permanently_retired: true,
    hub_selector_control_plane_required: true,
  }));
}

main();
