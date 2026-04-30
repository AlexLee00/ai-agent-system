#!/usr/bin/env tsx
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const hubStorePath = path.join(repoRoot, 'bots', 'hub', 'secrets-store.json');
const reservationStorePath = path.join(repoRoot, 'bots', 'reservation', 'secrets.json');
const TEAM_TOPIC_KEYS = [
  'general',
  'reservation',
  'ska',
  'investment',
  'luna',
  'claude',
  'claude_lead',
  'blog',
  'darwin',
  'justin',
  'sigma',
  'meeting',
  'emergency',
  'legal',
];
const OPS_TOPIC_KEYS = ['ops_work', 'ops_reports', 'ops_error_resolution', 'ops_emergency'];

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readJson(file: string): Record<string, any> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function normalizeTopicIds(raw: Record<string, any> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value == null || value === '') continue;
    result[key] = String(value);
  }
  return result;
}

function readTopicIds(): Record<string, string> {
  const hub = readJson(hubStorePath);
  const reservation = readJson(reservationStorePath);
  return {
    ...normalizeTopicIds(reservation.telegram_topic_ids),
    ...normalizeTopicIds(hub?.reservation?.telegram_topic_ids),
    ...normalizeTopicIds(hub?.telegram?.topic_ids || hub?.telegram?.telegram_topic_ids),
  };
}

function readPendingRows(file: string): Array<Record<string, any>> {
  try {
    if (!file || !fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line: string) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function buildQueueSnapshot() {
  try {
    const sender = require('../../../packages/core/lib/telegram-sender.ts');
    const paths = sender._testOnly_getPendingQueuePaths?.() || {};
    const active = readPendingRows(paths.pendingFile || '');
    const legacy = readPendingRows(paths.legacyPendingFile || '');
    const oldTeamRows = [...active, ...legacy].filter((row) => {
      const team = String(row.team || '').replace(/-/g, '_');
      return team && !team.startsWith('ops_') && TEAM_TOPIC_KEYS.includes(team);
    });
    return {
      paths,
      active_count: active.length,
      legacy_count: legacy.length,
      old_team_pending_count: oldTeamRows.length,
      old_team_pending_sample: oldTeamRows.slice(0, 10).map((row) => ({
        team: row.team || null,
        originalTeam: row.originalTeam || null,
        savedAt: row.savedAt || null,
      })),
    };
  } catch (error: any) {
    return {
      active_count: 0,
      legacy_count: 0,
      old_team_pending_count: 0,
      old_team_pending_sample: [],
      error: error?.message || 'pending_queue_scan_failed',
    };
  }
}

export function buildTelegramTeamTopicMonitor() {
  const topicIds = readTopicIds();
  const opsValues = OPS_TOPIC_KEYS.map((key) => topicIds[key]).filter(Boolean);
  const opsReady = OPS_TOPIC_KEYS.every((key) => Boolean(topicIds[key]));
  const teamAliases = TEAM_TOPIC_KEYS
    .filter((key) => topicIds[key])
    .map((key) => ({
      key,
      mapped_to_ops: opsValues.includes(topicIds[key]),
    }));
  const unmappedTeamAliases = teamAliases.filter((row) => !row.mapped_to_ops);
  const activeTeamAliases = teamAliases.map((row) => row.key).sort();
  const queue = buildQueueSnapshot();
  const ok = opsReady && activeTeamAliases.length === 0 && Number(queue.old_team_pending_count || 0) === 0;
  return {
    ok,
    class_topics_ready: opsReady,
    ops_topic_keys: OPS_TOPIC_KEYS,
    team_alias_count: teamAliases.length,
    active_team_alias_count: activeTeamAliases.length,
    active_team_aliases: activeTeamAliases,
    unmapped_team_alias_count: unmappedTeamAliases.length,
    unmapped_team_aliases: unmappedTeamAliases,
    pending_queue: queue,
    checked_at: new Date().toISOString(),
  };
}

function main() {
  const result = buildTelegramTeamTopicMonitor();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`telegram_team_topic_monitor: ok=${result.ok}`);
    console.log(`class_topics_ready=${result.class_topics_ready}`);
    console.log(`unmapped_team_aliases=${result.unmapped_team_alias_count}`);
    console.log(`old_team_pending=${result.pending_queue.old_team_pending_count}`);
  }
  if (hasFlag('strict') && !result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  buildTelegramTeamTopicMonitor,
};
