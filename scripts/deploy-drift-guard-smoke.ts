#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildDeployDriftGuardReport,
  compareLaunchdPlistState,
  compareLaunchdLiveState,
  parseLaunchctlPrint,
  scanDeployDriftTargets,
} from '../bots/_shared/hooks/deploy-drift-guard.ts';
import * as lunaGuard from '../bots/investment/shared/hooks/luna-deploy-drift-guard.ts';

function main() {
  const expected = {
    ProgramArguments: ['/usr/bin/env', 'node', 'server.js'],
    EnvironmentVariables: {
      LUNA_YAML_ROUTING_ENABLED: 'true',
      HUB_AUTH_TOKEN: 'secret-value',
      SAFE_FLAG: 'yes',
    },
  };
  const loaded = {
    ProgramArguments: ['/usr/bin/env', 'node', 'server.js'],
    EnvironmentVariables: {
      LUNA_YAML_ROUTING_ENABLED: 'false',
      HUB_AUTH_TOKEN: 'different-secret',
      SAFE_FLAG: 'yes',
    },
  };

  const report = compareLaunchdPlistState(expected, loaded, {
    envAllowlist: ['LUNA_YAML_ROUTING_ENABLED', 'HUB_AUTH_TOKEN', 'SAFE_FLAG'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.driftDetected, true);
  assert.equal(report.liveMutation, false);
  assert.deepEqual(
    report.diffs.find((diff) => diff.key === 'EnvironmentVariables').expected.HUB_AUTH_TOKEN,
    '[redacted]',
  );
  assert.equal(report.diffs.find((diff) => diff.key === 'EnvironmentVariables').expected.SAFE_FLAG, 'yes');

  const live = parseLaunchctlPrint(`
    state = running
    pid = 123
    arguments = {
      /usr/bin/env
      node
      server.js
    }
    environment = {
      LUNA_YAML_ROUTING_ENABLED => true
      HUB_AUTH_TOKEN => should_not_leak
    }
  `, ['LUNA_YAML_ROUTING_ENABLED', 'HUB_AUTH_TOKEN']);
  assert.equal(live.pid, 123);
  assert.deepEqual(live.ProgramArguments, ['/usr/bin/env', 'node', 'server.js']);
  assert.equal(live.EnvironmentVariables.HUB_AUTH_TOKEN, '[redacted]');

  const noEnvAllowlist = compareLaunchdLiveState(
    expected,
    {
      ProgramArguments: expected.ProgramArguments,
      WorkingDirectory: null,
      EnvironmentVariables: {},
    },
  );
  assert.equal(noEnvAllowlist.driftDetected, false, 'unread live env must not create drift without an allowlist');

  const liveDrift = buildDeployDriftGuardReport({
    expectedPlist: expected,
    loadedPlist: expected,
    label: 'ai.test.service',
    includeLiveState: true,
    envAllowlist: ['LUNA_YAML_ROUTING_ENABLED'],
    deps: {
      uid: 501,
      spawnSync: () => ({
        status: 0,
        stdout: `
          state = running
          pid = 321
          arguments = {
            /usr/bin/env
            node
            old-server.js
          }
          environment = {
            LUNA_YAML_ROUTING_ENABLED => false
          }
        `,
      }),
    },
  });
  assert.equal(liveDrift.driftDetected, true);
  assert.equal(liveDrift.liveDriftDetected, true);
  assert.ok(liveDrift.diffs.some((diff) => diff.key === 'LiveState.ProgramArguments'));
  assert.ok(liveDrift.diffs.some((diff) => diff.key === 'LiveState.EnvironmentVariables'));

  const scan = scanDeployDriftTargets({
    targets: [{ label: 'missing.test', repoPath: 'missing.plist' }],
    repoRoot: '/tmp/does-not-exist',
    home: '/tmp/does-not-exist',
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.reports[0].skipped, true);

  assert.equal(typeof lunaGuard.compareLaunchdPlistState, 'function');

  console.log(JSON.stringify({ ok: true, checks: 13 }, null, 2));
}

main();
