#!/usr/bin/env tsx
'use strict';

/**
 * report-deprecation-matrix.ts — distributed report launchd → 5 digest matrix.
 *
 * This script is intentionally read-only: it generates a master-review matrix
 * and never unloads launchd jobs.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const path = require('path');
const os = require('os');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const ROOT = env.PROJECT_ROOT;

type DigestCategory = 'hourly-status' | 'daily-metrics' | 'weekly-audit' | 'weekly-advisory' | 'incident-summary';
type DeprecationClass = 'immediate' | 'week1_grace' | 'week3_grace' | 'keep';

interface DigestDef {
  category: DigestCategory;
  plist: string;
  script: string;
  schedule: string;
  description: string;
}

interface LaunchdJob {
  label: string;
  plistPath: string;
  source: 'repo' | 'local';
  script: string;
  args: string[];
}

interface MatrixRow extends LaunchdJob {
  replacedBy: DigestCategory | 'none';
  deprecationClass: DeprecationClass;
  rationale: string;
  unloadCommand: string;
}

const DIGESTS: DigestDef[] = [
  {
    category: 'hourly-status',
    plist: 'ai.hub.hourly-status-digest',
    script: 'bots/hub/scripts/hourly-status-digest.ts',
    schedule: 'hourly',
    description: 'Hub/team health, routing readiness, high-level runtime status',
  },
  {
    category: 'daily-metrics',
    plist: 'ai.hub.daily-metrics-digest',
    script: 'bots/hub/scripts/daily-metrics-digest.ts',
    schedule: 'daily 09:00',
    description: 'Daily alarm/LLM/team metrics and operational counters',
  },
  {
    category: 'weekly-audit',
    plist: 'ai.hub.weekly-audit-digest',
    script: 'bots/hub/scripts/weekly-audit-digest.ts',
    schedule: 'weekly Monday 10:00',
    description: 'Safety, regression, policy, and audit coverage',
  },
  {
    category: 'weekly-advisory',
    plist: 'ai.hub.weekly-advisory-digest',
    script: 'bots/hub/scripts/weekly-advisory-digest.ts',
    schedule: 'weekly Monday 11:00',
    description: 'Master-review recommendations, noisy producers, tuning proposals',
  },
  {
    category: 'incident-summary',
    plist: 'ai.hub.incident-summary',
    script: 'bots/hub/scripts/incident-summary.ts',
    schedule: 'daily 18:00',
    description: 'Roundtable/auto_dev incident summary and unresolved items',
  },
];

const DIGEST_LABELS = new Set(DIGESTS.map((digest) => digest.plist));
const PROTECTED_LABEL_PATTERNS = [
  /resource-api/,
  /telegram-callback-poller/,
  /jay\.runtime/,
  /tradingview-ws/,
  /commander/,
  /marketdata-mcp/,
  /auto-dev\.autonomous/,
  /digest$/,
];
const RETIRED_LABEL_PATTERNS = [
  /^ai\.worker\./,
  /^ai\.video\./,
  /worker-ops/,
  /video-edi/,
];

const REPORT_HINTS = [
  'report',
  'readiness',
  'health',
  'audit',
  'metrics',
  'summary',
  'noise',
  'monitor',
  'status',
  'weekly',
  'daily',
  'advisory',
  'notifier',
  'check',
  'dashboard',
  'validate',
  'stale',
  'proposal',
];

function argValue(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg: string) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function walk(dir: string, predicate: (file: string) => boolean, output: string[] = []): string[] {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, predicate, output);
    else if (predicate(fullPath)) output.push(fullPath);
  }
  return output;
}

function parseStringAfterKey(text: string, key: string): string {
  const keyIndex = text.indexOf(`<key>${key}</key>`);
  if (keyIndex < 0) return '';
  const match = text.slice(keyIndex).match(/<string>([^<]+)<\/string>/);
  return match ? match[1] : '';
}

function parseProgramArguments(text: string): string[] {
  const keyIndex = text.indexOf('<key>ProgramArguments</key>');
  if (keyIndex < 0) return [];
  const arrayText = text.slice(keyIndex, text.indexOf('</array>', keyIndex) + '</array>'.length);
  return Array.from(arrayText.matchAll(/<string>([^<]+)<\/string>/g)).map((match) => match[1]);
}

function normalizeRelScript(arg: string): string {
  if (!arg) return '';
  if (arg.startsWith(ROOT)) return path.relative(ROOT, arg);
  return arg;
}

function parseLaunchdJob(plistPath: string, source: 'repo' | 'local'): LaunchdJob | null {
  const text = fs.readFileSync(plistPath, 'utf8');
  const label = parseStringAfterKey(text, 'Label') || path.basename(plistPath, '.plist');
  const args = parseProgramArguments(text);
  const scriptArg = args.find((arg) => /\.(ts|js|mjs|cjs|exs)$/.test(arg)) || '';
  return {
    label,
    plistPath,
    source,
    script: normalizeRelScript(scriptArg),
    args,
  };
}

function discoverLaunchdJobs(): LaunchdJob[] {
  const repoPlists = walk(ROOT, (file) => file.endsWith('.plist') && file.includes('/launchd/'));
  const localDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const localPlists = fs.existsSync(localDir)
    ? fs.readdirSync(localDir)
      .filter((file: string) => file.endsWith('.plist'))
      .map((file: string) => path.join(localDir, file))
    : [];

  const byLabel = new Map<string, LaunchdJob>();
  for (const [source, files] of [['repo', repoPlists], ['local', localPlists]] as const) {
    for (const file of files) {
      try {
        const job = parseLaunchdJob(file, source);
        if (!job) continue;
        if (RETIRED_LABEL_PATTERNS.some((pattern) => pattern.test(job.label) || pattern.test(job.script))) continue;
        const existing = byLabel.get(job.label);
        if (!existing || job.source === 'local') byLabel.set(job.label, job);
      } catch {
        // Invalid user-local plist should not fail matrix generation.
      }
    }
  }
  return Array.from(byLabel.values()).sort((a, b) => a.label.localeCompare(b.label) || a.source.localeCompare(b.source));
}

function isReportLike(job: LaunchdJob): boolean {
  const haystack = `${job.label} ${job.script} ${job.args.join(' ')}`.toLowerCase();
  if (DIGEST_LABELS.has(job.label)) return false;
  if (PROTECTED_LABEL_PATTERNS.some((pattern) => pattern.test(job.label))) return false;
  return REPORT_HINTS.some((hint) => haystack.includes(hint));
}

function mapDigest(job: LaunchdJob): DigestCategory {
  const haystack = `${job.label} ${job.script}`.toLowerCase();
  if (/(incident|bug|error|auto-dev|stale)/.test(haystack)) return 'incident-summary';
  if (/(audit|validate|guard|contract|regression|review)/.test(haystack)) return 'weekly-audit';
  if (/(advisory|proposal|suppression|noisy|notifier|recommend|autotune)/.test(haystack)) return 'weekly-advisory';
  if (/(daily|metrics|usage|cost|kpi|llm-daily)/.test(haystack)) return 'daily-metrics';
  return 'hourly-status';
}

function classifyDeprecation(job: LaunchdJob, replacedBy: DigestCategory): { deprecationClass: DeprecationClass; rationale: string } {
  const haystack = `${job.label} ${job.script}`.toLowerCase();
  if (/(live|trade|order|execute|cleanup|apply|runner|worker|daemon)/.test(haystack)) {
    return { deprecationClass: 'keep', rationale: 'contains live/action/daemon semantics; keep until separate owner review' };
  }
  if (/(health|readiness|status|dashboard)/.test(haystack) && replacedBy === 'hourly-status') {
    return { deprecationClass: 'immediate', rationale: 'covered by hourly status digest; safe to retire after parallel comparison' };
  }
  if (/(daily|metrics|report|summary)/.test(haystack)) {
    return { deprecationClass: 'week1_grace', rationale: `covered by ${replacedBy}; compare for one week before unload` };
  }
  if (/(audit|guard|validate|oauth|llm|suppression|noisy|proposal|weekly)/.test(haystack)) {
    return { deprecationClass: 'week3_grace', rationale: `risk-sensitive signal; keep three-week grace before unload` };
  }
  return { deprecationClass: 'keep', rationale: 'insufficient replacement confidence; keep pending manual review' };
}

export function buildDeprecationMatrix(jobs = discoverLaunchdJobs()): MatrixRow[] {
  return jobs
    .filter(isReportLike)
    .map((job) => {
      const replacedBy = mapDigest(job);
      const classification = classifyDeprecation(job, replacedBy);
      return {
        ...job,
        replacedBy,
        deprecationClass: classification.deprecationClass,
        rationale: classification.rationale,
        unloadCommand: `launchctl bootout gui/$(id -u) ${job.plistPath}`,
      };
    });
}

function classLabel(value: DeprecationClass): string {
  if (value === 'immediate') return '즉시 비활성화 후보';
  if (value === 'week1_grace') return '1주 grace 후보';
  if (value === 'week3_grace') return '3주 grace 후보';
  return '유지 권장';
}

function buildMarkdown(rows: MatrixRow[]): string {
  const today = kst.today ? kst.today() : new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    '# Report Deprecation Matrix',
    '',
    `> Generated: ${today} KST`,
    '> Scope: read-only matrix. This document does not unload or disable any launchd job.',
    '',
    '## Digest Targets',
    '',
    '| Digest | Launchd | Schedule | Coverage |',
    '| --- | --- | --- | --- |',
  ];
  for (const digest of DIGESTS) {
    lines.push(`| ${digest.category} | \`${digest.plist}\` | ${digest.schedule} | ${digest.description} |`);
  }

  const classes: DeprecationClass[] = ['immediate', 'week1_grace', 'week3_grace', 'keep'];
  lines.push('', '## Summary', '');
  lines.push('| Class | Count |');
  lines.push('| --- | ---: |');
  for (const cls of classes) {
    lines.push(`| ${classLabel(cls)} | ${rows.filter((row) => row.deprecationClass === cls).length} |`);
  }
  lines.push(`| Total candidates | ${rows.length} |`);

  lines.push('', '## Candidate Matrix', '');
  lines.push('| Class | Source | Launchd | Script | Replacement | Rationale |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    lines.push(`| ${classLabel(row.deprecationClass)} | ${row.source} | \`${row.label}\` | \`${row.script || '-'}\` | ${row.replacedBy} | ${row.rationale} |`);
  }

  lines.push('', '## Master Approval Workflow', '');
  lines.push('1. Week 1: keep all candidate jobs running in parallel with the 5 digest jobs.');
  lines.push('2. Week 2: unload only `immediate` candidates after comparing digest content.');
  lines.push('3. Week 3: unload `week1_grace` candidates if no information loss is observed.');
  lines.push('4. Week 4+: review `week3_grace` candidates one by one; keep action/daemon jobs.');
  lines.push('5. Every unload requires a rollback note and a retained log path for at least 30 days.');

  lines.push('', '## Unload Command Reference', '');
  lines.push('```bash');
  for (const row of rows.filter((item) => item.deprecationClass !== 'keep')) {
    lines.push(`# ${row.label} -> ${row.replacedBy}`);
    lines.push(row.unloadCommand);
  }
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function printWeek(rows: MatrixRow[], week: number): void {
  const targetClass = week === 1 ? 'immediate' : week === 2 ? 'week1_grace' : 'week3_grace';
  const targets = rows.filter((row) => row.deprecationClass === targetClass);
  console.log(`[deprecation-matrix] Week ${week} candidates: ${targets.length}`);
  for (const row of targets) {
    console.log(`${row.label}\t${row.replacedBy}\t${row.unloadCommand}`);
  }
}

async function main(): Promise<void> {
  const rows = buildDeprecationMatrix();
  const week = Number(argValue('week', ''));
  if ([1, 2, 3].includes(week)) {
    printWeek(rows, week);
    return;
  }

  const output = argValue('output', '');
  if (output) {
    const outputPath = path.isAbsolute(output) ? output : path.join(ROOT, output);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, buildMarkdown(rows), 'utf8');
    console.log(`[deprecation-matrix] wrote ${path.relative(ROOT, outputPath)} (${rows.length} candidates)`);
  } else if (!hasFlag('json')) {
    console.log(buildMarkdown(rows));
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify({
      ok: true,
      generated_at: new Date().toISOString(),
      digest_count: DIGESTS.length,
      candidate_count: rows.length,
      by_class: {
        immediate: rows.filter((row) => row.deprecationClass === 'immediate').length,
        week1_grace: rows.filter((row) => row.deprecationClass === 'week1_grace').length,
        week3_grace: rows.filter((row) => row.deprecationClass === 'week3_grace').length,
        keep: rows.filter((row) => row.deprecationClass === 'keep').length,
      },
      rows,
    }, null, 2));
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error('[report-deprecation-matrix] failed:', error.message);
    process.exit(1);
  });
}
