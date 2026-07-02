#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const DEFAULT_PROJECT_DOCS = path.join(os.homedir(), 'project-docs/ai-agent-system');
const DEFAULT_WIKI_DIR = path.join(DEFAULT_PROJECT_DOCS, 'wiki');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));

const TOPIC_RULES = [
  { topic: 'hub', pattern: /\bhub\b|resource-api|ops-mcp|llm_routing|routing/i },
  { topic: 'luna', pattern: /\bluna\b|investment|trading|risk|capital|kis|binance/i },
  { topic: 'claude', pattern: /\bclaude\b|archer|guardian|reviewer|refactor/i },
  { topic: 'sigma', pattern: /\bsigma\b|vault|wiki|knowledge|library/i },
  { topic: 'blog', pattern: /\bblog\b|naver|comment|curriculum|blo/i },
  { topic: 'dashboard', pattern: /dashboard|ai os|stream|sse|pwa/i },
  { topic: 'platform', pattern: /platform|harness|deploy|drift|cycle|trace|o3|skill/i },
];

export function parseArgs(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  return {
    json: argv.includes('--json'),
    write,
    dryRun: !write || argv.includes('--dry-run'),
    writeVault: write && argv.includes('--write-vault') && argv.includes('--no-dry-run'),
    noDb: argv.includes('--no-db'),
    limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 80) || 80,
    outDir: argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length) || DEFAULT_WIKI_DIR,
  };
}

function walkMarkdown(dir, max = 80) {
  const out = [];
  function visit(current) {
    if (out.length >= max || !fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= max) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  }
  visit(dir);
  return out;
}

function cleanText(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstHeading(content, fallback) {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function classifyTopic(text = '') {
  const found = TOPIC_RULES.find((rule) => rule.pattern.test(text));
  return found?.topic || 'platform';
}

function excerpt(content, max = 700) {
  const normalized = cleanText(content)
    .split(/\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('|'))
    .slice(0, 12)
    .join('\n');
  return normalized.slice(0, max).trim();
}

export function buildWikiEntriesFromDocuments(files, { baseDir = repoRoot } = {}) {
  const seen = new Set();
  const entries = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relative = path.relative(baseDir, file).replace(/\\/g, '/');
    const title = firstHeading(content, path.basename(file, '.md'));
    const topic = classifyTopic(`${title}\n${content}`);
    const sourceKey = `${topic}:${relative}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    entries.push({
      topic,
      title,
      source: relative,
      excerpt: excerpt(content),
    });
  }
  return entries;
}

export function mergeWikiPages(entries, existingPages = {}) {
  const byTopic = new Map();
  for (const entry of entries) {
    const list = byTopic.get(entry.topic) || [];
    if (!list.some((item) => item.source === entry.source)) list.push(entry);
    byTopic.set(entry.topic, list);
  }

  const pages = {};
  for (const [topic, list] of byTopic.entries()) {
    const existing = existingPages[topic] || '';
    const already = new Set([...existing.matchAll(/Source:\s+`([^`]+)`/g)].map((match) => match[1]));
    const newSections = list
      .filter((entry) => !already.has(entry.source))
      .map((entry) => [
        `## ${entry.title}`,
        '',
        `Source: \`${entry.source}\``,
        '',
        entry.excerpt || '_No excerpt available._',
      ].join('\n'));
    const header = existing.trim() || `# ${topic} wiki\n\nCompiled from Team Jay handoffs, incidents, meeting minutes, and design notes.`;
    pages[topic] = [header, ...newSections].filter(Boolean).join('\n\n').trim() + '\n';
  }
  return pages;
}

async function fetchMeetingMinuteEntries(limit = 30) {
  const rows = await pgPool.queryReadonly('investment', `
    SELECT meeting_id, agent, role, summary, full_text, created_at
    FROM investment.luna_meeting_minutes
    ORDER BY created_at DESC
    LIMIT $1
  `, [Math.max(1, Math.min(200, limit))]).catch(() => []);
  return rows.map((row) => ({
    topic: 'luna',
    title: `Meeting ${row.meeting_id || 'unknown'} ${row.agent || row.role || 'minute'}`,
    source: `db:investment.luna_meeting_minutes:${row.meeting_id || row.created_at}`,
    excerpt: excerpt(row.full_text || row.summary || '', 700),
  }));
}

function readExistingPages(outDir, topics) {
  const pages = {};
  for (const topic of topics) {
    const file = path.join(outDir, `${topic}.md`);
    if (fs.existsSync(file)) pages[topic] = fs.readFileSync(file, 'utf8');
  }
  return pages;
}

async function persistVaultPages(pages) {
  const { VaultManager } = await import('../vault/vault-manager.ts');
  const manager = new VaultManager();
  const results = [];
  for (const [topic, content] of Object.entries(pages)) {
    results.push(await manager.addToInbox({
      title: `LLM Wiki: ${topic}`,
      type: 'llm_wiki',
      content,
      tags: ['llm-wiki', topic],
      filePath: `library/sigma/llm-wiki/${topic}.md`,
      source: 'sigma',
      meta: { topic, generatedBy: 'llm-wiki-compile' },
    }));
  }
  return results;
}

export async function buildLlmWikiCompileReport(options = {}) {
  const projectDocs = options.projectDocs || DEFAULT_PROJECT_DOCS;
  const outDir = options.outDir || DEFAULT_WIKI_DIR;
  const files = [
    ...walkMarkdown(path.join(projectDocs, 'handoff'), options.limit),
    ...walkMarkdown(path.join(projectDocs, 'codex-specs'), Math.ceil(options.limit / 2)),
    ...walkMarkdown(path.join(repoRoot, 'docs/handoff'), Math.ceil(options.limit / 2)),
    ...walkMarkdown(path.join(repoRoot, 'docs/sessions'), Math.ceil(options.limit / 2)),
  ].slice(0, options.limit);
  const docEntries = buildWikiEntriesFromDocuments(files, { baseDir: projectDocs });
  const minuteEntries = options.noDb ? [] : await fetchMeetingMinuteEntries(30);
  const entries = [...docEntries, ...minuteEntries].filter((entry) => entry.excerpt);
  const topics = [...new Set(entries.map((entry) => entry.topic))].sort();
  const existing = readExistingPages(outDir, topics);
  const pages = mergeWikiPages(entries, existing);
  const duplicateRate = entries.length === 0
    ? 0
    : 1 - (new Set(entries.map((entry) => `${entry.topic}:${entry.source}`)).size / entries.length);
  return {
    ok: true,
    source: 'sigma_llm_wiki_compile',
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun !== false,
    liveMutation: false,
    fileMutation: false,
    outputDir: outDir,
    counts: {
      sourceFiles: files.length,
      dbMinutes: minuteEntries.length,
      entries: entries.length,
      topics: topics.length,
    },
    duplicateRate,
    topics,
    pages,
  };
}

async function main() {
  const args = parseArgs();
  const report = await buildLlmWikiCompileReport({
    outDir: args.outDir,
    limit: args.limit,
    noDb: args.noDb,
    dryRun: args.dryRun,
  });
  let vaultResults = [];
  if (args.write && !args.dryRun) {
    fs.mkdirSync(args.outDir, { recursive: true });
    for (const [topic, content] of Object.entries(report.pages)) {
      fs.writeFileSync(path.join(args.outDir, `${topic}.md`), content, 'utf8');
    }
    report.fileMutation = true;
  }
  if (args.writeVault) {
    vaultResults = await persistVaultPages(report.pages);
  }
  const output = { ...report, vaultResults: vaultResults.map((item) => ({ ok: item.ok, id: item.id || null, embedded: item.embedded })) };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`[llm-wiki] topics=${report.counts.topics} entries=${report.counts.entries} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[llm-wiki] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
