// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveReservationChildRuntime,
  resolveReservationManualScript,
} = require('../lib/runtime-paths.ts');

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '', 'utf8');
}

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-runtime-paths-'));

  try {
    const sourceRelPath = 'bots/reservation/manual/reservation/pickko-accurate.ts';
    const jsRelPath = 'bots/reservation/manual/reservation/pickko-accurate.js';
    const daemonPath = path.join(tmpRoot, 'dist/daemons/ai.ska.pickko-accurate.cjs');
    const jsPath = path.join(tmpRoot, jsRelPath);
    const sourcePath = path.join(tmpRoot, sourceRelPath);

    touch(jsPath);
    touch(sourcePath);

    assert.throws(
      () => resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'ops',
      }),
      /missing prebuilt reservation daemon/,
      'OPS must fail closed instead of executing mutable source or a JS bridge',
    );

    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'dev',
      }),
      jsPath,
      'JS bridge should be used when daemon is absent',
    );

    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath: 'manual/reservation/pickko-accurate.ts',
        jsRelPath: 'manual/reservation/pickko-accurate.js',
        projectRoot: tmpRoot,
        runtimeMode: 'dev',
      }),
      jsPath,
      'legacy manual/* inputs should normalize under bots/reservation/',
    );

    touch(daemonPath);
    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'dev',
      }),
      daemonPath,
      'daemon runtime should be preferred when available',
    );
    assert.deepEqual(
      resolveReservationChildRuntime({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'ops',
        nodeBin: '/fixture/node',
        tsxBin: '/fixture/tsx',
      }),
      { command: '/fixture/node', script: daemonPath },
      'OPS child runtime must execute the prebuilt daemon with Node',
    );

    fs.rmSync(daemonPath);
    fs.rmSync(jsPath);
    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'dev',
      }),
      sourcePath,
      'source path should be the final fallback',
    );
    assert.deepEqual(
      resolveReservationChildRuntime({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
        runtimeMode: 'dev',
        nodeBin: '/fixture/node',
        tsxBin: '/fixture/tsx',
      }),
      { command: '/fixture/tsx', script: sourcePath },
      'DEV child runtime may execute the source with tsx when no build exists',
    );

    const liveResolved = resolveReservationManualScript({
      label: 'ai.ska.pickko-accurate',
      sourceRelPath,
      jsRelPath,
      projectRoot: '/Users/alexlee/projects/ai-agent-system',
    });
    assert.ok(
      !liveResolved.includes('/ai-agent-system/manual/reservation/'),
      `live path must not resolve to stale root manual dir: ${liveResolved}`,
    );

    for (const relPath of [
      'bots/reservation/auto/scheduled/pickko-pay-scan.ts',
      'bots/reservation/manual/reservation/pickko-accurate.ts',
      'bots/reservation/manual/admin/pickko-verify.ts',
    ]) {
      const source = fs.readFileSync(path.join('/Users/alexlee/projects/ai-agent-system', relPath), 'utf8');
      assert.match(
        source,
        /resolveReservationChildRuntime/,
        `${relPath} must use the shared OPS prebuilt-runtime guard`,
      );
    }

    const verifyRunner = fs.readFileSync(
      '/Users/alexlee/projects/ai-agent-system/bots/reservation/manual/admin/run-verify.sh',
      'utf8',
    );
    assert.doesNotMatch(
      verifyRunner,
      /node_modules\/\.bin\/tsx/,
      'the OPS verify wrapper must not fall back to mutable TypeScript source',
    );
    assert.match(
      verifyRunner,
      /missing prebuilt/i,
      'the OPS verify wrapper must fail clearly when its daemon is missing',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('✅ reservation runtime paths smoke ok');
}

main();
