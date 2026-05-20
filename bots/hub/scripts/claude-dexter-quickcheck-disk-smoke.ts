#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const source = fs.readFileSync(
  path.join(PROJECT_ROOT, 'bots/claude/src/dexter-quickcheck.ts'),
  'utf8',
);

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

assert(
  !/(^|[^A-Za-z0-9_$])lerts\.push\s*\(/m.test(source),
  'dexter quickcheck must not contain lerts.push typo',
);
assert(
  source.includes("const failCount = diskPrev.status === 'critical'"),
  'disk critical path must track consecutive failCount',
);
assert(
  source.includes("alerts.push({\n        label: '디스크'") &&
    source.includes('failCount,'),
  'disk critical path must push a complete alert object with failCount',
);
assert(
  source.includes("recoveries.push({ label: '디스크'") &&
    source.includes("state.disk = { status: 'ok', usage: diskUsage, failCount: 0, alertedAt: null }"),
  'disk recovery path must keep recovery notification and reset failCount',
);

console.log(JSON.stringify({
  ok: true,
  smoke: 'claude-dexter-quickcheck-disk',
}));
