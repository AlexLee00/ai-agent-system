#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLayerRoute, coordsMatchFilters } from '../vault/layer-router.ts';
import { buildWikiEntrySetFromVaultRows, classifyVaultWikiSource } from './llm-wiki-compile.ts';
import { buildDocsVaultCandidates, walkMarkdown } from './runtime-sigma-docs-vault-feed.ts';
import { buildTeamVaultCandidates } from './runtime-sigma-team-vault-feed.ts';

function rawCoords() {
  return {
    libraryCoords: {
      abstraction_level: 'L0',
      time_stage: 'raw',
      validation_state: 'unverified',
      prediction_state: 'none',
    },
  };
}

async function main() {
  assert.equal(coordsMatchFilters({}, buildLayerRoute('최근 자료').coordFilters), true);
  assert.equal(coordsMatchFilters({}, buildLayerRoute('근거 원문').coordFilters), true);
  assert.equal(coordsMatchFilters({}, buildLayerRoute('원리').coordFilters), false);
  assert.equal(coordsMatchFilters({}, buildLayerRoute('다음 주 전망').coordFilters), false);
  assert.equal(coordsMatchFilters({}, buildLayerRoute('검증된 전략').coordFilters), false);

  const wikiSet = buildWikiEntrySetFromVaultRows([
    {
      id: 'w1',
      title: 'handoff source',
      type: 'handoff_doc',
      source: 'handoff',
      file_path: 'library/handoff/HANDOFF.md',
      content: 'handoff content',
      meta: rawCoords(),
    },
    {
      id: 'b1',
      title: 'review polluted blog comment',
      type: 'blog_comment',
      source: 'blo',
      file_path: 'library/blo/comment/1',
      content: 'review handoff luna_review reflexion',
      meta: rawCoords(),
    },
    {
      id: 'h1',
      title: 'hub alarm with handoff',
      type: 'hub_alarm',
      source: 'hub_alarm',
      file_path: 'library/hub_alarm/1',
      content: 'handoff marker',
      meta: rawCoords(),
    },
  ]);
  assert.equal(wikiSet.entries.length, 1);
  assert.equal(wikiSet.entries[0].vaultEntryId, 'w1');
  assert.equal(classifyVaultWikiSource({ source: 'hub_alarm', content: 'handoff', meta: rawCoords() }).reason, 'excluded_low_value_source');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-feed-expand-'));
  const handoff = path.join(tmp, 'handoff');
  fs.mkdirSync(handoff, { recursive: true });
  const handoffFile = path.join(handoff, 'HANDOFF_SAMPLE.md');
  fs.writeFileSync(handoffFile, '# Handoff Sample\n\n운영 인계 내용', 'utf8');
  const oldDir = path.join(handoff, 'aaa-old');
  const newDir = path.join(handoff, 'zzz-new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  const oldFile = path.join(oldDir, 'OLD.md');
  const newFile = path.join(newDir, 'NEW.md');
  fs.writeFileSync(oldFile, '# Old\n\nold', 'utf8');
  fs.writeFileSync(newFile, '# New\n\nnew', 'utf8');
  const oldTime = new Date(Date.now() - 120000);
  const sampleTime = new Date(Date.now() - 180000);
  const newTime = new Date(Date.now() - 1000);
  fs.utimesSync(handoffFile, sampleTime, sampleTime);
  fs.utimesSync(oldFile, oldTime, oldTime);
  fs.utimesSync(newFile, newTime, newTime);
  const newestOnly = walkMarkdown(handoff, Date.now() - 3600000, 1);
  assert.equal(newestOnly.length, 1);
  assert.equal(path.basename(newestOnly[0].file), 'NEW.md', 'walkMarkdown should sort all candidates before applying limit');
  const docsCandidates = buildDocsVaultCandidates({
    baseDir: tmp,
    handoffFiles: [{ file: handoffFile, stat: fs.statSync(handoffFile) }],
    meetingMinutes: [{ session_id: 'm1', seq: 1, speaker: 'luna', role: 'analyst', content: '회의록 전문', created_at: '2026-07-03T00:00:00.000Z' }],
  });
  assert.equal(docsCandidates.length, 2);
  assert.deepEqual(new Set(docsCandidates.map((item) => item.source)), new Set(['handoff', 'meeting_minutes']));
  assert.equal(docsCandidates.every((item) => item.filePath.startsWith('library/')), true);

  const teamCandidates = buildTeamVaultCandidates({
    skaDaily: [{ date: '2026-07-03', total_amount: 120000, general_revenue: 70000, pickko_study_room: 50000 }],
    skaReservations: [{ date: '2026-07-03', total_reservations: 5, active_reservations: 4, cancelled_reservations: 1, completed_reservations: 3 }],
    darwinResearch: [{ paper_id: 'arxiv-1', title: 'Agentic R&D', stage: 'evaluated', source: 'arxiv', keywords: ['agent'], metadata: { relevance_score: 0.91 } }],
    darwinCycles: [{ cycle_id: 'cycle-1', verification_status: 'passed', summary: 'prototype verified' }],
  });
  assert.equal(teamCandidates.length, 4);
  assert.equal(teamCandidates.some((item) => item.source === 'ska_daily_summary'), true);
  assert.equal(teamCandidates.some((item) => item.source === 'darwin_research'), true);
  assert.equal(teamCandidates.every((item) => !/010-?\d|phone|전화번호/i.test(item.content)), true);

  const sigmaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const runner = spawnSync(process.execPath, [
    '--disable-warning=DEP0205',
    '--import',
    'tsx',
    'scripts/runtime-sigma-docs-vault-feed.ts',
    '--json',
    '--no-db',
    '--no-sample-embedding',
    `--handoff-dir=${handoff}`,
    '--limit=1',
    '--since-hours=1',
  ], {
    cwd: sigmaRoot,
    encoding: 'utf8',
  });
  assert.equal(runner.status, 0, `docs vault feed runner exit mismatch: ${runner.stderr || runner.stdout}`);
  const runnerJson = JSON.parse(runner.stdout);
  assert.equal(runnerJson.ok, true, 'docs vault feed runner JSON should be ok');
  assert.equal(runnerJson.dryRun, true, 'docs vault feed runner should stay dry-run by default');

  console.log(JSON.stringify({ ok: true, smoke: 'sigma-feed-expand', checks: 21 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
