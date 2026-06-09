#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const {
  buildSecurityHardening,
} = require('../lib/stage-c/resilience');

function main(): void {
  const security = buildSecurityHardening();
  assert.equal(security.ok, true, 'Stage C security hardening checks must pass');
  assert(security.checks.length >= 6, 'Stage C security must map multiple OWASP controls');
  for (const check of security.checks) {
    assert.equal(check.ok, true, `security check failed: ${check.name}`);
    assert(check.owasp, `security check must include OWASP mapping: ${check.name}`);
  }
  assert(
    security.requiredCommands.some((command: string) => command.includes('secret-leak-smoke')),
    'Stage C security must require tracked-file secret scan',
  );

  console.log(JSON.stringify({
    ok: true,
    stage: 'hub_stage_c',
    standard: security.standard,
    checks: security.checks.map((check: { name: string }) => check.name),
  }, null, 2));
}

main();
