#!/usr/bin/env tsx
/*
 * Post-history-rewrite doctor.
 *
 * Verifies that protected refs are clean and identifies local stale refs that
 * still retain old secret-bearing history. This script is read-only: it prints
 * cleanup candidates but never deletes branches/tags.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

type HistoryFinding = {
  rule: string;
  commit: string;
  date?: string;
  subject?: string;
  file: string;
};

type ScanResult = {
  ok: boolean;
  count: number;
  findings: HistoryFinding[];
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const HISTORY_SCAN = path.join(REPO_ROOT, 'scripts', 'security', 'secret-history-scan.ts');
const VERBOSE = process.env.SECURITY_DOCTOR_VERBOSE === '1';

function run(command: string, args: string[], options: { env?: Record<string, string> } = {}) {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

function runGit(args: string[]): string {
  const result = run('git', args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.status}`);
  }
  return result.stdout.trim();
}

function parseJsonOutput(stdout: string): ScanResult {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('history scan did not return JSON');
  return JSON.parse(stdout.slice(start));
}

function scanHistory(allRefs: boolean): ScanResult {
  const result = run(TSX_BIN, [HISTORY_SCAN], {
    env: allRefs ? { SECRET_HISTORY_SCAN_ALL_REFS: '1' } : {},
  });
  if (result.error) throw result.error;
  return parseJsonOutput(result.stdout || '{}');
}

function refsContaining(commit: string): string[] {
  let fullCommit = commit;
  try {
    fullCommit = runGit(['rev-parse', `${commit}^{commit}`]);
  } catch {
    return [];
  }

  const refs = runGit([
    'for-each-ref',
    '--contains',
    fullCommit,
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]);
  return refs.split(/\r?\n/).map((ref: string) => ref.trim()).filter(Boolean);
}

function currentState() {
  return {
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: runGit(['rev-parse', '--short=12', 'HEAD']),
    originMain: runGit(['rev-parse', '--short=12', 'origin/main']),
    treeMatchesOriginMain: runGit(['rev-parse', 'HEAD^{tree}']) === runGit(['rev-parse', 'origin/main^{tree}']),
  };
}

function buildStaleRefReport(findings: HistoryFinding[]) {
  const rows = findings.map((finding) => ({
    ...finding,
    refs: refsContaining(finding.commit),
  }));
  const refs = [...new Set(rows.flatMap((row) => row.refs))].sort();
  return { rows, refs };
}

function main() {
  const protectedScan = scanHistory(false);
  const allRefsScan = scanHistory(true);
  const stale = buildStaleRefReport(allRefsScan.findings || []);
  const staleFindings = stale.rows.map((row) => ({
    rule: row.rule,
    commit: row.commit,
    date: row.date,
    subject: row.subject,
    file: row.file,
    refs_count: row.refs.length,
    ...(VERBOSE ? { refs: row.refs } : {}),
  }));
  const payload = {
    ok: protectedScan.ok && allRefsScan.ok,
    protected_refs_clean: protectedScan.ok,
    all_local_refs_clean: allRefsScan.ok,
    current: currentState(),
    protected_findings_count: protectedScan.count,
    all_refs_findings_count: allRefsScan.count,
    stale_refs: stale.refs,
    stale_findings: staleFindings,
    verbose: VERBOSE,
    next_actions: allRefsScan.ok
      ? []
      : [
          'Review stale_refs. Delete only refs you no longer need.',
          'Prefer fresh clone for deployment/runner machines after force-push.',
          'Run SECRET_HISTORY_SCAN_ALL_REFS=1 npm run -s security:scan-history after local cleanup.',
        ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.ok ? 0 : 1);
}

main();
