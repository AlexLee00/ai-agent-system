'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const targetPath = path.join(__dirname, '../lib/failure-trajectory.ts');

type ModuleLoad = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;

async function main() {
  const originalLoad: ModuleLoad = Module._load as ModuleLoad;
  const calls: Array<{ kind: string; payload: Record<string, unknown> }> = [];

  Module._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
    if (request === './event-lake') {
      return {
        record: async (payload: Record<string, unknown>) => {
          calls.push({ kind: 'event', payload });
          return 101;
        },
      };
    }
    if (request === './experience-store') {
      return {
        storeExperience: async (payload: Record<string, unknown>) => {
          calls.push({ kind: 'experience', payload });
          return 202;
        },
      };
    }
    if (request === './rag') {
      return {
        search: async (collection: string, query: string, options: Record<string, unknown>) => {
          calls.push({ kind: 'rag.search', payload: { collection, query, options } });
          return [{
            content: 'previous failure',
            metadata: { agent: 'doctor', signature: 'abc' },
          }];
        },
      };
    }
    if (request === './trace') {
      return { getTraceId: () => 'trace-smoke' };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[targetPath];
    const trajectory = require(targetPath);
    const built = trajectory.buildFailureTrajectory({
      team: 'claude',
      agent: 'doctor',
      intent: 'restart_launchd_service',
      command: ['launchctl', 'kickstart', 'gui/501/ai.test'],
      exitCode: 1,
      stdout: 'ok',
      stderr: `first\n${'x'.repeat(1800)}`,
      rootCause: 'service exited',
      resolutionHint: 'restart after cooldown',
    });

    assert.strictEqual(built.team, 'claude');
    assert.strictEqual(built.agent, 'doctor');
    assert.strictEqual(built.traceId, 'trace-smoke');
    assert.strictEqual(built.command, 'launchctl kickstart gui/501/ai.test');
    assert.strictEqual(built.stderrTail.length, 1600);
    assert.match(built.signature, /^[a-f0-9]{16}$/);

    const recorded = await trajectory.recordFailureTrajectory({
      team: 'claude',
      agent: 'doctor',
      intent: 'restart_launchd_service',
      command: 'launchctl kickstart',
      stderr: 'Bootstrap failed',
      rootCause: 'launchd bootstrap failure',
      incidentKey: 'claude:doctor:test',
      metadata: {
        kind: 'overridden',
        signature: 'bad',
      },
    });
    assert.match(recorded.signature, /^[a-f0-9]{16}$/);
    assert.strictEqual(recorded.experienceId, 202);
    assert.strictEqual(recorded.eventId, 101);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].kind, 'experience');
    assert.strictEqual(calls[0].payload.result, 'failure');
    assert.strictEqual(calls[0].payload.successOnly, false);
    assert.strictEqual((calls[0].payload.details as Record<string, unknown>).kind, 'failure_trajectory');
    assert.notStrictEqual((calls[0].payload.details as Record<string, unknown>).signature, 'bad');
    assert.deepStrictEqual((calls[0].payload.details as Record<string, unknown>).metadata, {
      kind: 'overridden',
      signature: 'bad',
    });
    assert.strictEqual(calls[1].kind, 'event');
    assert.strictEqual(calls[1].payload.eventType, 'failure_trajectory_recorded');

    const hints = await trajectory.searchFailureHints('bootstrap failed', {
      team: 'claude',
      agent: 'doctor',
      intent: 'restart_launchd_service',
    });
    assert.strictEqual(hints.length, 1);
    assert.strictEqual(hints[0].metadata.agent, 'doctor');
    const searchCall = calls.find((call) => call.kind === 'rag.search');
    assert.ok(searchCall, 'expected rag.search call');
    assert.strictEqual(searchCall.payload.collection, 'experience');
    const searchOptions = searchCall.payload.options as Record<string, unknown>;
    assert.deepStrictEqual(searchOptions.filter, {
      kind: 'failure_trajectory',
      result: 'failure',
      intent: 'restart_launchd_service',
      team: 'claude',
      agent: 'doctor',
    });

    console.log('✅ failure trajectory smoke ok');
  } finally {
    Module._load = originalLoad;
    delete require.cache[targetPath];
  }
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
