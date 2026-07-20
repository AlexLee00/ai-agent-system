#!/usr/bin/env tsx

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const source = fs.readFileSync(
  path.join(PROJECT_ROOT, 'bots/claude/src/dexter-quickcheck.ts'),
  'utf8',
);
const mainbotClientSource = fs.readFileSync(
  path.join(PROJECT_ROOT, 'bots/claude/lib/mainbot-client.ts'),
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
  source.includes('isNew || failCount === 2 || reAlert') &&
    source.includes('failCount === 2 ||\n        (prev.status'),
  'dexter quickcheck must report the second consecutive failure before cooldown',
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
assert(
  source.includes('buildHealthObservationPolicy') &&
    source.includes('incident_key: policy.incidentKey') &&
    source.includes('resource_id: policy.resourceId') &&
    source.includes('dedupe_minutes: dedupeMinutes'),
  'dexter quickcheck alerts must use stable resource lifecycle keys and dedupe window',
);
assert(
  source.includes('shouldSkipQuickcheckTeamLeadAlert(item._key)') &&
    source.includes('const QUICKCHECK_SERVICE_IDS = new Set'),
  'dexter quickcheck must not duplicate team-leads alerts for services it already checks directly',
);
assert(
  mainbotClientSource.includes('incident_key,') &&
    mainbotClientSource.includes('dedupe_minutes,') &&
    mainbotClientSource.includes('incidentKey: incident_key || incidentKey') &&
    mainbotClientSource.includes('dedupeMinutes: dedupe_minutes ?? dedupeMinutes'),
  'claude mainbot client must forward quickcheck incident_key and dedupe_minutes to Hub alarm',
);

console.log(JSON.stringify({
  ok: true,
  smoke: 'claude-dexter-quickcheck-disk',
}));
