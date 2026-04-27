#!/usr/bin/env tsx
'use strict';

const { buildAlarmReadinessSnapshot } = require('../lib/alarm/readiness.ts');

function main(): void {
  const snapshot = buildAlarmReadinessSnapshot();
  console.log(JSON.stringify(snapshot, null, 2));
  process.exitCode = snapshot.ok ? 0 : 1;
}

main();
