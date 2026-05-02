#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Category =
  | 'runtime_blocker'
  | 'retired_gateway_guard'
  | 'documentation'
  | 'generated_inventory'
  | 'ignored_log'
  | 'dirty_worktree'
  | 'retired_home_archive_pending';

type Finding = {
  category: Category;
  file: string;
  line?: number | null;
  snippet?: string;
  reason: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const outputDir = path.join(repoRoot, 'bots', 'hub', 'output');
const outputJsonPath = path.join(outputDir, 'openclaw-residue-audit.json');
const outputMarkdownPath = path.join(repoRoot, 'docs', 'hub', 'OPENCLAW_RESIDUE_AUDIT.md');
const retiredName = ['open', 'claw'].join('');
const retiredEnvPrefix = ['OPEN', 'CLAW_'].join('');
const retiredGatewayPort = ['187', '89'].join('');

const markerPatterns = [
  retiredName,
  'OpenClaw',
  retiredEnvPrefix,
  retiredGatewayPort,
  'legacy_gateway',
  'openclaw-client',
  'openclaw-gateway',
];

const guardFiles = new Set([
  'bots/hub/scripts/hub-transition-completion-gate.ts',
  'bots/hub/scripts/legacy-gateway-admin-guard-smoke.ts',
  'bots/hub/scripts/legacy-gateway-independence-smoke.ts',
  'bots/hub/scripts/generate-hub-alarm-inventory.ts',
  'bots/hub/scripts/retired-gateway-residue-audit.ts',
  'bots/hub/scripts/retired-gateway-cutover-readiness.ts',
  'bots/hub/scripts/openclaw-runtime-retirement-smoke.ts',
  'bots/hub/scripts/retired-gateway-marker-precommit-smoke.ts',
  'bots/hub/scripts/runtime-env-policy-smoke.ts',
  'bots/hub/scripts/runtime-workspace-independence-smoke.ts',
  'bots/hub/scripts/run-tests.ts',
  'bots/hub/lib/alarm/cluster.ts',
  'packages/core/lib/runtime-env-policy.ts',
  'scripts/pre-commit',
]);

function run(command: string, args: string[], options: { cwd?: string } = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sanitizeSnippet(value: string): string {
  return String(value || '')
    .replace(/(access_token|refresh_token|client_secret|api_key|auth_token|token|secret|password)\s*[:=]\s*['"][^'"]+['"]/gi, '$1=<redacted>')
    .slice(0, 220);
}

function classifyRepoFinding(file: string): { category: Category; reason: string } {
  if (file.endsWith('.log') || file.includes('/logs/')) {
    return { category: 'ignored_log', reason: 'ignored historical log' };
  }
  if (file.endsWith('.md')) {
    return { category: 'documentation', reason: 'markdown documentation/report reference' };
  }
  if (file.startsWith('bots/hub/output/') || file === 'docs/hub/OPENCLAW_RESIDUE_AUDIT.md' || file === 'docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md') {
    return { category: 'generated_inventory', reason: 'generated audit output' };
  }
  if (file.startsWith('bots/hub/scripts/') && /(?:smoke|audit|inventory|transition|readiness|report|monitor)/.test(path.basename(file))) {
    return { category: 'retired_gateway_guard', reason: 'intentional smoke/report guard' };
  }
  if (guardFiles.has(file)) {
    return { category: 'retired_gateway_guard', reason: 'intentional regression guard' };
  }
  if (file.startsWith('docs/') || file.startsWith('README')) {
    return { category: 'documentation', reason: 'documentation/history reference' };
  }
  if (file.startsWith('.claude/worktrees/') || file.includes('/.claude/worktrees/')) {
    return { category: 'dirty_worktree', reason: 'agent worktree outside main runtime' };
  }
  return { category: 'runtime_blocker', reason: 'retired gateway marker in runtime source' };
}

function scanRepoMarkers(): Finding[] {
  const patternArgs = markerPatterns.flatMap((pattern) => ['-e', pattern]);
  const result = run('rg', [
    '-n',
    '-S',
    ...patternArgs,
    '.',
    '-g',
    '!**/node_modules/**',
    '-g',
    '!**/.git/**',
    '-g',
    '!**/dist/**',
    '-g',
    '!docs/codex/**',
    '-g',
    '!bots/hub/output/**',
    '-g',
    '!docs/hub/OPENCLAW_RESIDUE_AUDIT.md',
    '-g',
    '!docs/hub/HUB_ALARM_DEPENDENCY_INVENTORY.md',
    '-g',
    '!**/*.log',
  ]);

  if (![0, 1].includes(Number(result.status))) {
    throw new Error(`marker scan failed: ${result.stderr || result.stdout || result.status}`);
  }

  return String(result.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const firstColon = line.indexOf(':');
      const secondColon = line.indexOf(':', firstColon + 1);
      const rawFile = firstColon > 0 ? line.slice(0, firstColon) : line;
      const file = rawFile.replace(/^\.\//, '');
      const lineNo = secondColon > firstColon ? Number(line.slice(firstColon + 1, secondColon)) : null;
      const snippet = secondColon > firstColon ? line.slice(secondColon + 1).trim() : '';
      const classified = classifyRepoFinding(file);
      return {
        category: classified.category,
        file,
        line: Number.isFinite(lineNo) ? lineNo : null,
        snippet: sanitizeSnippet(snippet),
        reason: classified.reason,
      };
    });
}

function scanIgnoredLogs(): Finding[] {
  const patternArgs = markerPatterns.flatMap((pattern) => ['-e', pattern]);
  const result = run('rg', [
    '-l',
    '-S',
    ...patternArgs,
    'bots',
    '-g',
    '**/*.log',
    '-g',
    '!**/node_modules/**',
  ]);

  if (![0, 1].includes(Number(result.status))) {
    throw new Error(`log marker scan failed: ${result.stderr || result.stdout || result.status}`);
  }

  return String(result.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((rawFile) => ({
      category: 'ignored_log' as Category,
      file: rawFile.replace(/^\.\//, ''),
      reason: 'ignored historical log contains retired gateway marker',
    }));
}

function parseWorktreePaths(): string[] {
  const result = run('git', ['worktree', 'list', '--porcelain']);
  if (Number(result.status) !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function scanWorktrees(): Finding[] {
  const findings: Finding[] = [];
  for (const worktreePath of parseWorktreePaths()) {
    const relative = path.relative(repoRoot, worktreePath);
    const file = relative.startsWith('..') ? worktreePath : relative;
    if (worktreePath.includes(`${path.sep}.${retiredName}${path.sep}`)) {
      findings.push({
        category: 'runtime_blocker',
        file,
        reason: 'retired gateway worktree is still registered',
      });
      continue;
    }
    if (worktreePath.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) {
      const status = run('git', ['-C', worktreePath, 'status', '--short']);
      const dirtyLines = String(status.stdout || '').trim().split('\n').filter(Boolean);
      if (dirtyLines.length > 0) {
        findings.push({
          category: 'dirty_worktree',
          file,
          snippet: `${dirtyLines.length} changed entries`,
          reason: 'dirty agent worktree retained for manual review',
        });
      }
    }
  }
  return findings;
}

function directorySizeKb(dir: string): number {
  const result = run('du', ['-sk', dir], { cwd: repoRoot });
  if (Number(result.status) !== 0) return 0;
  const first = String(result.stdout || '').trim().split(/\s+/)[0];
  const sizeKb = Number(first);
  return Number.isFinite(sizeKb) ? sizeKb : 0;
}

function scanRetiredHome(): Finding[] {
  const homeDir = path.join(os.homedir(), `.${retiredName}`);
  if (!fs.existsSync(homeDir)) return [];
  const sizeMb = Math.round(directorySizeKb(homeDir) / 1024);
  return [{
    category: 'retired_home_archive_pending',
    file: homeDir,
    snippet: `${sizeMb} MB`,
    reason: 'retired home directory exists; archive/delete requires explicit data-retention decision',
  }];
}

function countByCategory(findings: Finding[]): Record<Category, number> {
  const categories: Category[] = [
    'runtime_blocker',
    'retired_gateway_guard',
    'documentation',
    'generated_inventory',
    'ignored_log',
    'dirty_worktree',
    'retired_home_archive_pending',
  ];
  return categories.reduce((acc, category) => {
    acc[category] = findings.filter((finding) => finding.category === category).length;
    return acc;
  }, {} as Record<Category, number>);
}

function writeOutputs(findings: Finding[]): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const categories = countByCategory(findings);
  const payload = {
    generated_at: new Date().toISOString(),
    ok: categories.runtime_blocker === 0,
    categories,
    findings,
  };

  fs.writeFileSync(outputJsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const byCategory = findings.reduce((acc, finding) => {
    acc[finding.category] = acc[finding.category] || [];
    acc[finding.category].push(finding);
    return acc;
  }, {} as Record<Category, Finding[]>);

  const sections = Object.entries(byCategory).map(([category, entries]) => {
    const lines = entries.slice(0, 80).map((entry) => {
      const line = entry.line ? `:${entry.line}` : '';
      const snippet = entry.snippet ? ` — \`${entry.snippet}\`` : '';
      return `- ${entry.file}${line} (${entry.reason})${snippet}`;
    });
    const more = entries.length > 80 ? [`- ... ${entries.length - 80} more`] : [];
    return [`## ${category}`, '', ...lines, ...more].join('\n');
  });

  const markdown = [
    '# OpenClaw Residue Audit',
    '',
    'This generated report classifies retired OpenClaw references. `runtime_blocker` must remain 0. Guard, documentation, ignored log, and archive-pending entries are tracked separately so they do not masquerade as live runtime dependencies.',
    '',
    `- generated_at: ${payload.generated_at}`,
    `- ok: ${payload.ok}`,
    `- runtime_blocker: ${categories.runtime_blocker}`,
    `- retired_gateway_guard: ${categories.retired_gateway_guard}`,
    `- documentation: ${categories.documentation}`,
    `- generated_inventory: ${categories.generated_inventory}`,
    `- ignored_log: ${categories.ignored_log}`,
    `- dirty_worktree: ${categories.dirty_worktree}`,
    `- retired_home_archive_pending: ${categories.retired_home_archive_pending}`,
    '',
    ...sections,
    '',
  ].join('\n');
  fs.writeFileSync(outputMarkdownPath, markdown, 'utf8');
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function main(): void {
  const findings = [
    ...scanRepoMarkers(),
    ...scanIgnoredLogs(),
    ...scanWorktrees(),
    ...scanRetiredHome(),
  ].sort((a, b) => `${a.category}:${a.file}:${a.line || 0}`.localeCompare(`${b.category}:${b.file}:${b.line || 0}`));
  const categories = countByCategory(findings);
  const checkOnly = hasFlag('--check-only');
  if (!checkOnly) {
    writeOutputs(findings);
  }

  const summary = {
    ok: categories.runtime_blocker === 0,
    check_only: checkOnly,
    categories,
    output_json: outputJsonPath,
    output_markdown: outputMarkdownPath,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main();
