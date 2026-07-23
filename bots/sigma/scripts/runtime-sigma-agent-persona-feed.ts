#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachSourceRefToMeta } from '../shared/source-ref.ts';
import { VaultManager } from '../vault/vault-manager.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function safeTeam(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '');
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function buildAgentPersonaEntry(team, options = {}) {
  const normalizedTeam = safeTeam(team);
  if (!normalizedTeam) throw new Error('team_required');
  const filePath = options.filePath || path.join(repoRoot, 'bots', normalizedTeam, 'AGENTS.md');
  if (!fs.existsSync(filePath)) throw new Error(`persona_not_found:${normalizedTeam}`);
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) throw new Error(`persona_empty:${normalizedTeam}`);
  return {
    title: `[agent_persona] ${normalizedTeam}`,
    type: 'agent_persona',
    content,
    tags: ['sigma-library', normalizedTeam, 'persona', 'identity'],
    filePath: `library/${normalizedTeam}/persona/AGENTS.md`,
    source: normalizedTeam,
    meta: attachSourceRefToMeta({
      team: normalizedTeam,
      sourceKind: 'agent_persona',
      canonicalPath: path.relative(repoRoot, filePath),
    }, {
      team: normalizedTeam,
      table: 'repo.agent_persona',
      id: 'AGENTS.md',
    }),
    libraryCoords: {
      abstraction_level: 'L2',
      time_stage: 'pattern',
      validation_state: 'validated',
      prediction_state: 'none',
      prediction_horizon: null,
    },
  };
}

export async function runAgentPersonaFeed(options = {}) {
  const team = safeTeam(options.team || 'jay');
  const entry = buildAgentPersonaEntry(team, { filePath: options.filePath });
  const apply = options.write === true && options.dryRun === false;
  if (!apply) return { ok: true, dryRun: true, applied: false, team, entry };
  const manager = options.manager || new VaultManager();
  const result = await manager.addToInbox(entry);
  return { ok: Boolean(result?.ok), dryRun: false, applied: Boolean(result?.ok), team, entry, result };
}

async function main() {
  const report = await runAgentPersonaFeed({
    team: argValue('team', 'jay'),
    write: hasFlag('write'),
    dryRun: !hasFlag('no-dry-run'),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }));
    process.exit(1);
  });
}
