#!/usr/bin/env tsx
/*
 * Fast tracked-file secret scanner for L5 safety checks.
 *
 * This is intentionally narrow and value-redacting: it catches high-confidence
 * provider token shapes without ever printing the token itself.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

type Rule = {
  name: string;
  pattern: RegExp;
};

type Finding = {
  file: string;
  line: number;
  rule: string;
  preview: string;
};

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const RULES: Rule[] = [
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'openai_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { name: 'anthropic_key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g },
  { name: 'groq_key', pattern: /\bgsk_[A-Za-z0-9]{30,}\b/g },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'github_ghp', pattern: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'telegram_bot_token', pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: 'google_oauth_secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'jwt_literal', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
];

const BINARY_EXTENSIONS = new Set([
  '.gif', '.ico', '.jpg', '.jpeg', '.pdf', '.png', '.webp',
  '.docx', '.pptx', '.xlsx', '.zip',
]);

const FAKE_TOKEN_MARKERS = [
  'canary-permission-smoke-token',
  'chatgpt-backend-smoke-token',
  'claude-access-token',
  'claude-refresh-token',
  'codex-backend-direct-token',
  'codex-refresh-token',
  'dry-claude-access-token',
  'hub-control-callback-smoke-secret',
  'hub-control-smoke-token',
  'l5-acceptance-token',
  'oauth-smoke-token',
  'route-refresh-token',
  'smoke-hooks-token',
  'token-store-smoke-token',
];

function trackedFiles(): string[] {
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'buffer' });
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function shouldSkipFile(file: string): boolean {
  if (file.includes('/node_modules/') || file.startsWith('node_modules/')) return true;
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  return false;
}

function isAllowedFake(file: string, value: string): boolean {
  if (FAKE_TOKEN_MARKERS.some((marker) => value.includes(marker))) return true;
  if (/(^|\/)(__tests__|scripts)\//.test(file) && /fake|fixture|smoke|test|dummy/i.test(value)) return true;
  if (/example|sample|template|README|CLAUDE\.md/.test(file) && /YOUR_|__SET_|placeholder|example|dummy/i.test(value)) return true;
  return false;
}

function redact(value: string): string {
  if (value.length <= 12) return '[redacted]';
  return `${value.slice(0, 4)}...${value.slice(-4)} (${value.length} chars)`;
}

function scanFile(file: string): Finding[] {
  if (shouldSkipFile(file)) return [];

  const absolute = path.join(REPO_ROOT, file);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return [];

  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\0')) return [];

  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        const value = match[0];
        if (isAllowedFake(file, value)) continue;
        findings.push({
          file,
          line: lineIndex + 1,
          rule: rule.name,
          preview: redact(value),
        });
      }
    }
  }
  return findings;
}

function main() {
  const findings = trackedFiles().flatMap(scanFile);
  if (findings.length > 0) {
    console.error('[secret-leak-smoke] high-confidence secret patterns detected in tracked files');
    for (const finding of findings.slice(0, 50)) {
      console.error(`- ${finding.file}:${finding.line} ${finding.rule} ${finding.preview}`);
    }
    if (findings.length > 50) {
      console.error(`- ... ${findings.length - 50} more finding(s) omitted`);
    }
    process.exit(1);
  }
  console.log('[secret-leak-smoke] tracked files passed high-confidence secret scan');
}

main();
