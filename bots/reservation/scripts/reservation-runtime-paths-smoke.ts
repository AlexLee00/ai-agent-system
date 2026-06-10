// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveReservationManualScript } = require('../lib/runtime-paths.ts');

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

    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
      }),
      jsPath,
      'JS bridge should be used when daemon is absent',
    );

    touch(daemonPath);
    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
      }),
      daemonPath,
      'daemon runtime should be preferred when available',
    );

    fs.rmSync(daemonPath);
    fs.rmSync(jsPath);
    assert.equal(
      resolveReservationManualScript({
        label: 'ai.ska.pickko-accurate',
        sourceRelPath,
        jsRelPath,
        projectRoot: tmpRoot,
      }),
      sourcePath,
      'source path should be the final fallback',
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
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log('✅ reservation runtime paths smoke ok');
}

main();
