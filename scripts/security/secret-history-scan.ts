#!/usr/bin/env tsx
/*
 * Redacted git-history scanner.
 *
 * This uses git pickaxe to identify commits/files where high-confidence secret
 * token shapes were introduced or removed. It intentionally never prints the
 * matched value. Use it for incident triage before any history rewrite.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

type Rule = {
  name: string;
  pattern: string;
};

type Finding = {
  rule: string;
  commit: string;
  date: string;
  subject: string;
  file: string;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const RULES: Rule[] = [
  { name: 'openai_key', pattern: String.raw`sk-(proj-)?[A-Za-z0-9_-]{32,}` },
  { name: 'anthropic_key', pattern: String.raw`sk-ant-[A-Za-z0-9_-]{32,}` },
  { name: 'groq_key', pattern: String.raw`gsk_[A-Za-z0-9]{30,}` },
  { name: 'github_pat', pattern: String.raw`github_pat_[A-Za-z0-9_]{20,}` },
  { name: 'github_ghp', pattern: String.raw`ghp_[A-Za-z0-9]{20,}` },
  { name: 'slack_token', pattern: String.raw`xox[baprs]-[A-Za-z0-9-]{20,}` },
  { name: 'aws_access_key', pattern: String.raw`AKIA[0-9A-Z]{16}` },
  { name: 'telegram_bot_token', pattern: String.raw`[0-9]{6,12}:[A-Za-z0-9_-]{30,}` },
  { name: 'google_oauth_secret', pattern: String.raw`GOCSPX-[A-Za-z0-9_-]{20,}` },
  { name: 'private_key_block', pattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----` },
];

function runGit(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.status}`);
  }
  return result.stdout || '';
}

function scanRule(rule: Rule): Finding[] {
  const output = runGit([
    'log',
    '--all',
    '--pickaxe-regex',
    '-S',
    rule.pattern,
    '--name-only',
    '--format=%x1e%H%x09%ad%x09%s',
    '--date=iso-strict',
    '--',
    '.',
    ':(exclude)node_modules',
  ]);

  const findings: Finding[] = [];
  for (const block of output.split('\x1e').filter(Boolean)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) continue;

    const [commit, date, ...subjectParts] = lines[0].split('\t');
    if (!/^[0-9a-f]{40}$/.test(commit || '')) continue;

    for (const file of lines.slice(1)) {
      findings.push({
        rule: rule.name,
        commit: commit.slice(0, 12),
        date,
        subject: subjectParts.join('\t'),
        file,
      });
    }
  }
  return findings;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const finding of findings) {
    const key = `${finding.rule}\0${finding.commit}\0${finding.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

function main() {
  const findings = dedupe(RULES.flatMap(scanRule));
  const payload = {
    ok: findings.length === 0,
    count: findings.length,
    findings,
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(findings.length ? 1 : 0);
}

main();
