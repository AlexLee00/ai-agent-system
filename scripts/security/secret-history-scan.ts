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
  gitPattern: string;
  valuePattern: RegExp;
};

type Finding = {
  rule: string;
  commit: string;
  date: string;
  subject: string;
  file: string;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REF_SCOPE = process.env.SECRET_HISTORY_SCAN_ALL_REFS === '1'
  ? ['--all']
  : ['refs/heads/main', 'refs/remotes/origin/main'];

const RULES: Rule[] = [
  {
    name: 'openai_key',
    gitPattern: String.raw`sk-[A-Za-z0-9_-]{32,}`,
    valuePattern: /\bsk-(?:proj-)?(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[0-9_])[A-Za-z0-9_-]+\b/g,
  },
  {
    name: 'anthropic_key',
    gitPattern: String.raw`sk-ant-[A-Za-z0-9_-]{32,}`,
    valuePattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    name: 'groq_key',
    gitPattern: String.raw`gsk_[A-Za-z0-9]{30,}`,
    valuePattern: /\bgsk_[A-Za-z0-9]{30,}\b/g,
  },
  {
    name: 'github_pat',
    gitPattern: String.raw`github_pat_[A-Za-z0-9_]{20,}`,
    valuePattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    name: 'github_ghp',
    gitPattern: String.raw`ghp_[A-Za-z0-9]{20,}`,
    valuePattern: /\bghp_[A-Za-z0-9]{20,}\b/g,
  },
  {
    name: 'slack_token',
    gitPattern: String.raw`xox[baprs]-[A-Za-z0-9-]{20,}`,
    valuePattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  },
  {
    name: 'aws_access_key',
    gitPattern: String.raw`AKIA[0-9A-Z]{16}`,
    valuePattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    name: 'telegram_bot_token',
    gitPattern: String.raw`[0-9]{6,12}:[A-Za-z0-9_-]{30,}`,
    valuePattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    name: 'google_oauth_secret',
    gitPattern: String.raw`GOCSPX-[A-Za-z0-9_-]{20,}`,
    valuePattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    name: 'private_key_block',
    gitPattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    valuePattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
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
    '--pickaxe-regex',
    '-S',
    rule.gitPattern,
    '--name-only',
    '--format=%x1e%H%x09%ad%x09%s',
    '--date=iso-strict',
    ...REF_SCOPE,
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
      if (!hasConfirmedMatch(commit, file, rule)) continue;
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

function hasConfirmedMatch(commit: string, file: string, rule: Rule): boolean {
  const result = spawnSync('git', ['show', `${commit}:${file}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });
  if (result.status !== 0 || !result.stdout) return false;
  rule.valuePattern.lastIndex = 0;
  return rule.valuePattern.test(result.stdout);
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
