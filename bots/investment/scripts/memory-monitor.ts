#!/usr/bin/env node
// @ts-nocheck

import { checkMemoryPressure } from '../shared/memory-pressure-guard.ts';

const json = process.argv.includes('--json');
const check = checkMemoryPressure();
const payload = {
  ok: true,
  checkedAt: new Date().toISOString(),
  ...check,
};

if (json) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  const free = payload.freePct == null ? 'n/a' : `${Number(payload.freePct).toFixed(1)}%`;
  console.log(`[MemoryMonitor] pressured=${payload.pressured} level=${payload.level} freePct=${free} detail=${payload.detail}`);
}

if (payload.level === 'critical') process.exitCode = 2;
