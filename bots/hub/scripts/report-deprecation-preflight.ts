#!/usr/bin/env tsx
'use strict';

/**
 * report-deprecation-preflight.ts — safety gate before report launchd retirement.
 *
 * This script is read-only. It verifies that the 5 digest launchd jobs are
 * loaded, protected runtime jobs are not part of the retirement matrix, and
 * immediate candidates are separated into local runtime actions vs repo-only
 * cleanup candidates.
 */

import { createRequire } from 'module';
import { buildDeprecationMatrix } from './report-deprecation-matrix.ts';

const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const ROOT = env.PROJECT_ROOT;

const DIGEST_LABELS = [
  'ai.hub.hourly-status-digest',
  'ai.hub.daily-metrics-digest',
  'ai.hub.weekly-audit-digest',
  'ai.hub.weekly-advisory-digest',
  'ai.hub.incident-summary',
];

const PROTECTED_LABELS = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.claude.auto-dev.autonomous',
  ...DIGEST_LABELS,
];

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg: string) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function launchctlLabels(): Set<string> {
  try {
    const output = childProcess.execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    const labels = new Set<string>();
    for (const line of output.split('\n')) {
      const label = line.trim().split(/\s+/).pop();
      if (label && label.startsWith('ai.')) labels.add(label);
    }
    return labels;
  } catch {
    return new Set<string>();
  }
}

function buildPreflight() {
  const loadedLabels = launchctlLabels();
  const rows = buildDeprecationMatrix();
  const immediateRows = rows.filter((row: any) => row.deprecationClass === 'immediate');
  const protectedInMatrix = rows
    .filter((row: any) => PROTECTED_LABELS.includes(row.label))
    .map((row: any) => row.label);
  const digestStatus = DIGEST_LABELS.map((label) => ({
    label,
    loaded: loadedLabels.has(label),
  }));
  const missingDigests = digestStatus.filter((item) => !item.loaded).map((item) => item.label);
  const immediateCandidates = immediateRows.map((row: any) => {
    const loaded = loadedLabels.has(row.label);
    const plistExists = fs.existsSync(row.plistPath);
    const runtimeAction = row.source === 'local' && loaded && plistExists;
    return {
      label: row.label,
      source: row.source,
      script: row.script || '',
      replacement: row.replacedBy,
      loaded,
      plist_exists: plistExists,
      runtime_action: runtimeAction ? 'ready_for_master_approved_unload' : 'no_runtime_action',
      reason: runtimeAction
        ? 'local launchd is loaded and covered by digest replacement'
        : row.source === 'repo'
          ? 'repo template candidate only; no loaded local runtime action detected'
          : 'local candidate is not currently loaded or plist is missing',
      unload_command: row.unloadCommand,
    };
  });
  const replacementMissing = immediateCandidates
    .filter((candidate) => !loadedLabels.has(`ai.hub.${candidate.replacement}-digest`) && candidate.replacement !== 'incident-summary')
    .map((candidate) => candidate.label);
  const incidentSummaryMissing = immediateCandidates
    .filter((candidate) => candidate.replacement === 'incident-summary' && !loadedLabels.has('ai.hub.incident-summary'))
    .map((candidate) => candidate.label);
  const blockers = [
    ...missingDigests.map((label) => `missing_digest:${label}`),
    ...protectedInMatrix.map((label: string) => `protected_label_in_matrix:${label}`),
    ...replacementMissing.map((label: string) => `missing_replacement_digest:${label}`),
    ...incidentSummaryMissing.map((label: string) => `missing_replacement_digest:${label}`),
  ];

  const runtimeUnloadReadyCount = immediateCandidates.filter((candidate) => candidate.runtime_action === 'ready_for_master_approved_unload').length;
  const repoOnlyOrNotLoadedCount = immediateCandidates.filter((candidate) => candidate.runtime_action !== 'ready_for_master_approved_unload').length;
  const status = blockers.length > 0
    ? 'blocked'
    : runtimeUnloadReadyCount === 0 && immediateCandidates.length > 0
      ? 'immediate_unload_verified'
      : 'ready_for_parallel_observation';

  return {
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    status,
    digest_status: digestStatus,
    protected_labels: PROTECTED_LABELS.map((label) => ({ label, loaded: loadedLabels.has(label) })),
    immediate_count: immediateCandidates.length,
    runtime_unload_ready_count: runtimeUnloadReadyCount,
    repo_only_or_not_loaded_count: repoOnlyOrNotLoadedCount,
    blockers,
    immediate_candidates: immediateCandidates,
    next_actions: blockers.length > 0
      ? [
        'Fix blockers before considering report launchd retirement.',
        'Do not unload any report launchd while digest coverage is incomplete.',
      ]
      : runtimeUnloadReadyCount === 0
        ? [
        'Monitor the 5 digest jobs for information loss after immediate candidate unload.',
        'Keep Week 1 grace and Week 3 grace candidates loaded until their review windows complete.',
        'Use the retained local plist files as rollback sources if any digest coverage gap is observed.',
      ]
        : [
        'Keep all immediate candidates running during the Week 1 parallel observation window.',
        'Compare digest content against each candidate before any unload.',
        'Unload only runtime_action=ready_for_master_approved_unload candidates after explicit master approval.',
      ],
  };
}

function buildMarkdown(report: ReturnType<typeof buildPreflight>): string {
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  const lines = [
    '# Report Deprecation Preflight',
    '',
    `> Generated: ${today} KST`,
    '> Scope: read-only safety gate. This document does not unload or disable launchd jobs.',
    '',
    '## Summary',
    '',
    `- status: \`${report.status}\``,
    `- immediate candidates: ${report.immediate_count}`,
    `- runtime unload ready after approval: ${report.runtime_unload_ready_count}`,
    `- repo-only or not loaded: ${report.repo_only_or_not_loaded_count}`,
    `- blockers: ${report.blockers.length}`,
    '',
    '## Digest Runtime Status',
    '',
    '| Digest Launchd | Loaded |',
    '| --- | --- |',
  ];
  for (const digest of report.digest_status) {
    lines.push(`| \`${digest.label}\` | ${digest.loaded ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Protected Runtime Labels', '', '| Label | Loaded |', '| --- | --- |');
  for (const protectedLabel of report.protected_labels) {
    lines.push(`| \`${protectedLabel.label}\` | ${protectedLabel.loaded ? 'yes' : 'no'} |`);
  }
  lines.push('', '## Immediate Candidate Preflight', '', '| Label | Source | Replacement | Loaded | Action | Reason |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const candidate of report.immediate_candidates) {
    lines.push(`| \`${candidate.label}\` | ${candidate.source} | ${candidate.replacement} | ${candidate.loaded ? 'yes' : 'no'} | ${candidate.runtime_action} | ${candidate.reason} |`);
  }
  lines.push('', '## Next Actions', '');
  for (const action of report.next_actions) {
    lines.push(`- ${action}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const report = buildPreflight();
  const output = argValue('output', '');
  if (output) {
    const outputPath = path.isAbsolute(output) ? output : path.join(ROOT, output);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, buildMarkdown(report), 'utf8');
    console.log(`[deprecation-preflight] wrote ${path.relative(ROOT, outputPath)} (${report.immediate_count} immediate candidates)`);
  }
  if (hasFlag('json') || !output) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (!report.ok && hasFlag('strict')) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error('[report-deprecation-preflight] failed:', error.message);
    process.exit(1);
  });
}
