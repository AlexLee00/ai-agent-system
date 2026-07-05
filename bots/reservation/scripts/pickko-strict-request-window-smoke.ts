'use strict';

const assert = require('assert');
const { buildSlotCandidates } = require('../lib/pickko-slot-helpers.ts');

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function assertStrictCandidates(envPatch) {
  withEnv(
    {
      MODE: null,
      STRICT_TIME: null,
      PICKKO_STRICT_REQUEST_WINDOW: null,
      ...envPatch,
    },
    () => {
      const candidates = buildSlotCandidates(['19:00', '19:30', '20:00', '20:30', '21:00', '21:30']);
      assert.deepStrictEqual(candidates, [
        {
          start: '19:00',
          end: '22:00',
          endClick: '21:30',
          slotCount: 6,
          durationMin: 180,
          reason: 'original-window',
        },
      ]);
    },
  );
}

withEnv(
  {
    MODE: null,
    STRICT_TIME: null,
    PICKKO_STRICT_REQUEST_WINDOW: null,
  },
  () => {
    const candidates = buildSlotCandidates(['19:00', '19:30', '20:00']);
    assert.ok(candidates.some((candidate) => candidate.reason === 'shrink-window'));
  },
);

assertStrictCandidates({ PICKKO_STRICT_REQUEST_WINDOW: '1' });
assertStrictCandidates({ STRICT_TIME: '1' });
assertStrictCandidates({ MODE: 'ops' });

console.log('✅ pickko strict request window smoke ok');
