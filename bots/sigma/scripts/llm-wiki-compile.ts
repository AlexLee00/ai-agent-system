#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeLibraryCoords } from '../shared/library-coords.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const DEFAULT_PROJECT_DOCS = path.join(os.homedir(), 'project-docs/ai-agent-system');
const DEFAULT_WIKI_DIR = path.join(DEFAULT_PROJECT_DOCS, 'wiki');
const WIKI_STATE_FILE = '.llm-wiki-state.json';
const COORD_COLUMNS = ['abstraction_level', 'time_stage', 'validation_state', 'prediction_state', 'prediction_horizon'];
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.ts'));
const hubClient = require(path.join(repoRoot, 'packages/core/lib/hub-client.ts'));
const cycleTrace = require(path.join(repoRoot, 'packages/core/lib/cycle-trace.ts'));
const HIGH_VALUE_WIKI_SOURCES = [
  'luna_review',
  'luna_reflexion',
  'handoff',
  'meeting_minutes',
  'sigma_directive',
];
const EXCLUDED_WIKI_SOURCES = [
  'blo',
  'blog_comment',
  'blog_comment_action',
  'blog_comment_inbound',
  'blog_post',
  'hub_alarm',
];
const HIGH_VALUE_WIKI_PATTERNS = [
  '%luna_review%',
  '%luna-review%',
  '%reflexion%',
  '%handoff%',
  '%sigma_directive%',
  '%sigma-directive%',
];
const LOW_VALUE_DIGEST_PATTERNS = [
  '%blog_comment%',
  '%blog-comment%',
  '%neighbor_comment%',
  '%comment_post%',
  '%comment/action%',
  '%library/blo/comment%',
];

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
    legacyDocSource: argv.includes('--legacy-doc-source'),
    llmPreview: !argv.includes('--no-llm-preview'),
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

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'object') return meta;
  try {
    return JSON.parse(String(meta));
  } catch {
    return {};
  }
}

function statePath(outDir) {
  return path.join(outDir, WIKI_STATE_FILE);
}

export function readWikiState(outDir = DEFAULT_WIKI_DIR) {
  try {
    const raw = fs.readFileSync(statePath(outDir), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      processedVaultEntryIds: Array.isArray(parsed.processedVaultEntryIds) ? parsed.processedVaultEntryIds : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { version: 1, processedVaultEntryIds: [], updatedAt: null };
  }
}

export function nextWikiState(previous, vaultEntryIds, now = new Date()) {
  const ids = [...new Set([...(previous?.processedVaultEntryIds || []), ...(vaultEntryIds || [])])].slice(-10000);
  return {
    version: 1,
    processedVaultEntryIds: ids,
    updatedAt: now.toISOString(),
  };
}

function writeWikiState(outDir, state) {
  fs.writeFileSync(statePath(outDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function formatCoords(coords = {}) {
  const normalized = normalizeLibraryCoords(coords);
  return `y=${normalized.abstraction_level} z=${normalized.time_stage} w=${normalized.validation_state} p=${normalized.prediction_state}`;
}

function rowCoords(row) {
  const meta = parseMeta(row.meta);
  return normalizeLibraryCoords({
    ...(meta.libraryCoords || {}),
    abstraction_level: row.abstraction_level || meta.libraryCoords?.abstraction_level,
    time_stage: row.time_stage || meta.libraryCoords?.time_stage,
    validation_state: row.validation_state || meta.libraryCoords?.validation_state,
    prediction_state: row.prediction_state || meta.libraryCoords?.prediction_state,
    prediction_horizon: row.prediction_horizon || meta.libraryCoords?.prediction_horizon,
  });
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

function rowSearchText(row) {
  return [
    row?.title,
    row?.type,
    row?.source,
    row?.file_path,
    row?.content,
    typeof row?.meta === 'string' ? row.meta : JSON.stringify(row?.meta || {}),
  ].filter(Boolean).join('\n').toLowerCase();
}

function rowSourceKind(row) {
  const meta = parseMeta(row?.meta);
  return String(row?.source || meta.sourceKind || row?.type || '').trim().toLowerCase();
}

function matchesPatternText(text, patterns) {
  const normalizedPatterns = (patterns || []).map((pattern) => String(pattern).replace(/%/g, '').toLowerCase());
  return normalizedPatterns.some((pattern) => pattern && text.includes(pattern));
}

export function classifyVaultWikiSource(row) {
  const text = rowSearchText(row);
  const source = rowSourceKind(row);
  if (HIGH_VALUE_WIKI_SOURCES.includes(source)) {
    return {
      lane: 'wiki',
      reason: matchesPatternText(text, HIGH_VALUE_WIKI_PATTERNS) ? 'source_whitelist_with_marker' : 'source_whitelist',
    };
  }
  if (matchesPatternText(text, LOW_VALUE_DIGEST_PATTERNS)) {
    return { lane: 'dreaming_digest', reason: 'low_value_blog_comment' };
  }
  if (EXCLUDED_WIKI_SOURCES.includes(source) || source.startsWith('claude_')) {
    return { lane: 'ignored', reason: 'excluded_low_value_source' };
  }
  return { lane: 'ignored', reason: 'not_high_value_for_wiki' };
}

export function buildWikiEntrySetFromVaultRows(rows, { processedVaultEntryIds = [] } = {}) {
  const processed = new Set(processedVaultEntryIds || []);
  const seen = new Set();
  const entries = [];
  const skipped = [];
  for (const row of rows || []) {
    const id = String(row.id || '').trim();
    if (!id || processed.has(id)) continue;
    const coords = rowCoords(row);
    if (coords.abstraction_level !== 'L0' || coords.time_stage !== 'raw') continue;
    const lane = classifyVaultWikiSource(row);
    if (lane.lane !== 'wiki') {
      skipped.push({
        vaultEntryId: id,
        lane: lane.lane,
        reason: lane.reason,
        title: row.title || row.file_path || `vault ${id}`,
        filePath: row.file_path || null,
        source: row.source || null,
      });
      continue;
    }
    const title = String(row.title || row.file_path || `vault ${id}`).trim();
    const content = row.content || row.content_preview || '';
    const topic = classifyTopic(`${title}\n${content}\n${row.source || ''}\n${row.file_path || ''}`);
    const source = `vault-entry:${id}`;
    const sourceKey = `${topic}:${source}`;
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    entries.push({
      topic,
      title,
      source,
      excerpt: excerpt(content),
      coords,
      vaultEntryId: id,
      filePath: row.file_path || null,
      createdAt: row.created_at || null,
    });
  }
  return { entries, skipped };
}

export function buildWikiEntriesFromVaultRows(rows, { processedVaultEntryIds = [] } = {}) {
  return buildWikiEntrySetFromVaultRows(rows, { processedVaultEntryIds }).entries;
}

async function detectCoordColumns(queryReadonly = pgPool.queryReadonly) {
  try {
    const rows = await queryReadonly('sigma', `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sigma'
        AND table_name = 'vault_entries'
        AND column_name = ANY($1::text[])
    `, [COORD_COLUMNS]);
    const set = new Set((Array.isArray(rows) ? rows : rows?.rows ?? []).map((row) => row.column_name));
    return COORD_COLUMNS.filter((column) => set.has(column));
  } catch {
    return [];
  }
}

async function fetchVaultRowsBySources({ sources, limit, queryReadonly, coordSelect }) {
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'active') <> 'archived'
      AND (
        LOWER(COALESCE(source, '')) = ANY($1::text[])
        OR LOWER(COALESCE(meta->>'sourceKind', '')) = ANY($1::text[])
      )
    ORDER BY created_at DESC
    LIMIT $2
  `, [sources, Math.max(1, Math.min(500, Number(limit) || 80))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

async function fetchVaultRowsByPatterns({ patterns, limit, queryReadonly, coordSelect }) {
  const rows = await queryReadonly('sigma', `
    SELECT id, title, type, content, source, file_path, meta, created_at${coordSelect}
    FROM sigma.vault_entries
    WHERE COALESCE(status, 'active') <> 'archived'
      AND (
        COALESCE(title, '') ILIKE ANY($1::text[])
        OR COALESCE(type, '') ILIKE ANY($1::text[])
        OR COALESCE(source, '') ILIKE ANY($1::text[])
        OR COALESCE(file_path, '') ILIKE ANY($1::text[])
        OR COALESCE(content, '') ILIKE ANY($1::text[])
        OR COALESCE(meta::text, '') ILIKE ANY($1::text[])
      )
    ORDER BY created_at DESC
    LIMIT $2
  `, [patterns, Math.max(1, Math.min(500, Number(limit) || 80))]);
  return Array.isArray(rows) ? rows : rows?.rows ?? [];
}

export async function fetchVaultWikiEntrySet({ limit = 80, state = null, queryReadonly = pgPool.queryReadonly } = {}) {
  const coordColumns = await detectCoordColumns(queryReadonly);
  const coordSelect = coordColumns.length > 0
    ? `, ${coordColumns.join(', ')}`
    : '';
  const highValueRows = await fetchVaultRowsBySources({
    sources: HIGH_VALUE_WIKI_SOURCES,
    limit,
    queryReadonly,
    coordSelect,
  });
  const digestRows = await fetchVaultRowsByPatterns({
    patterns: LOW_VALUE_DIGEST_PATTERNS,
    limit,
    queryReadonly,
    coordSelect,
  }).catch(() => []);
  const wikiSet = buildWikiEntrySetFromVaultRows([...highValueRows, ...digestRows], {
    processedVaultEntryIds: state?.processedVaultEntryIds || [],
  });
  const digestCandidates = wikiSet.skipped.filter((item) => item.lane === 'dreaming_digest');
  return {
    ...wikiSet,
    digestCandidates,
  };
}

export async function fetchVaultWikiEntries({ limit = 80, state = null, queryReadonly = pgPool.queryReadonly } = {}) {
  const entrySet = await fetchVaultWikiEntrySet({ limit, state, queryReadonly });
  return entrySet.entries;
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
        entry.coords ? `Coords: \`${formatCoords(entry.coords)}\`` : null,
        entry.filePath ? `Raw: \`${entry.filePath}\`` : null,
        '',
        entry.excerpt || '_No excerpt available._',
      ].filter((line) => line !== null).join('\n'));
    const header = existing.trim() || [
      `# ${topic} wiki`,
      '',
      'Library Coords: `y=L2 z=digest w=observed p=none`',
      '',
      'Compiled from Sigma vault raw entries and linked back to immutable source entries.',
    ].join('\n');
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
      libraryCoords: {
        abstraction_level: 'L2',
        time_stage: 'digest',
        validation_state: 'observed',
        prediction_state: 'none',
      },
    }));
  }
  return results;
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function buildLlmPreviewPrompt(topic, entries) {
  const sources = entries.slice(0, 6).map((entry, index) => [
    `SOURCE ${index + 1}`,
    `title: ${entry.title}`,
    `source: ${entry.source}`,
    `coords: ${entry.coords ? formatCoords(entry.coords) : 'unknown'}`,
    `excerpt: ${entry.excerpt}`,
  ].join('\n')).join('\n\n');
  return [
    'Sigma wiki page generation preview.',
    `Topic: ${topic}`,
    'Summarize and conceptualize the sources for a high-value internal wiki page.',
    'Return JSON only: {"summary":"...","concepts":["..."],"qualityGate":"pass|warn","notes":["..."]}.',
    '',
    sources,
  ].join('\n');
}

function applyLlmPreviewToPages(pages, previews = []) {
  const byTopic = new Map((previews || []).filter((preview) => preview?.topic).map((preview) => [preview.topic, preview]));
  const out = { ...pages };
  for (const [topic, preview] of byTopic.entries()) {
    if (!out[topic]) continue;
    const concepts = Array.isArray(preview.concepts) && preview.concepts.length > 0
      ? preview.concepts.map((concept) => `- ${concept}`).join('\n')
      : '- _No concepts returned._';
    const block = [
      '## LLM Concept Preview',
      '',
      `Cycle: \`${preview.cycleId || 'n/a'}\``,
      `Quality: \`${preview.qualityGate || 'warn'}\``,
      '',
      preview.summary || '_No summary returned._',
      '',
      'Concepts:',
      concepts,
    ].join('\n');
    out[topic] = out[topic].replace(/\n?$/, `\n\n${block}\n`);
  }
  return out;
}

export async function buildLlmWikiPreviews({
  entries = [],
  maxCalls = 1,
  llmClient = hubClient.callHubLlm,
  now = new Date(),
} = {}) {
  const trace = cycleTrace.createCycleTrace('sigma.llm-wiki-compile', { startedAt: now.getTime() });
  const warnings = [];
  const previews = [];
  const byTopic = new Map();
  for (const entry of entries || []) {
    const list = byTopic.get(entry.topic) || [];
    list.push(entry);
    byTopic.set(entry.topic, list);
  }
  const topics = [...byTopic.keys()].sort().slice(0, Math.max(0, Number(maxCalls) || 0));
  for (const topic of topics) {
    try {
      const response = await llmClient({
        callerTeam: 'sigma',
        agent: 'llm-wiki-compiler',
        selectorKey: 'sigma.agent_policy',
        taskType: 'wiki_compile',
        abstractModel: 'claude_code_haiku',
        systemPrompt: 'You are Sigma wiki compiler. Return compact JSON only.',
        prompt: buildLlmPreviewPrompt(topic, byTopic.get(topic) || []),
        maxTokens: 450,
        temperature: 0.1,
        timeoutMs: 30000,
        maxBudgetUsd: 0.01,
        policyOverride: {
          chain: [
            { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 450, temperature: 0.1, timeoutMs: 30000 },
          ],
        },
        cycleId: trace.cycleId,
        cycle_id: trace.cycleId,
        traceId: trace.traceId,
        trace_id: trace.traceId,
      });
      const parsed = extractJsonObject(response?.text || response?.result || '');
      previews.push({
        topic,
        cycleId: trace.cycleId,
        traceId: trace.traceId,
        provider: response?.provider || null,
        model: response?.model || response?.selected_route || null,
        summary: String(parsed.summary || '').trim(),
        concepts: Array.isArray(parsed.concepts) ? parsed.concepts.map((item) => String(item).trim()).filter(Boolean).slice(0, 8) : [],
        qualityGate: ['pass', 'warn'].includes(parsed.qualityGate) ? parsed.qualityGate : 'warn',
        notes: Array.isArray(parsed.notes) ? parsed.notes.map((item) => String(item).trim()).filter(Boolean).slice(0, 5) : [],
      });
    } catch (error) {
      warnings.push({ topic, error: error?.message || String(error) });
    }
  }
  return {
    enabled: topics.length > 0,
    cycleId: trace.cycleId,
    traceId: trace.traceId,
    calls: previews.length,
    previews,
    warnings,
  };
}

export async function buildLlmWikiCompileReport(options = {}) {
  const projectDocs = options.projectDocs || DEFAULT_PROJECT_DOCS;
  const outDir = options.outDir || DEFAULT_WIKI_DIR;
  const limit = Math.max(1, Math.min(500, Number(options.limit || 80) || 80));
  const state = options.state || readWikiState(outDir);
  let files = [];
  let docEntries = [];
  let minuteEntries = [];
  let vaultEntries = [];
  let vaultSkipped = [];
  let digestCandidates = [];
  let sourceMode = 'vault';

  if (!options.noDb) {
    const entrySet = await fetchVaultWikiEntrySet({
      limit,
      state,
      queryReadonly: options.queryReadonly || pgPool.queryReadonly,
    }).catch(() => ({ entries: [], skipped: [], digestCandidates: [] }));
    vaultEntries = entrySet.entries || [];
    vaultSkipped = entrySet.skipped || [];
    digestCandidates = entrySet.digestCandidates || [];
  }

  if (options.noDb || options.legacyDocSource) {
    sourceMode = options.noDb ? 'document_fixture' : 'legacy_documents';
    files = [
      ...walkMarkdown(path.join(projectDocs, 'handoff'), limit),
      ...walkMarkdown(path.join(projectDocs, 'codex-specs'), Math.ceil(limit / 2)),
      ...walkMarkdown(path.join(repoRoot, 'docs/handoff'), Math.ceil(limit / 2)),
      ...walkMarkdown(path.join(repoRoot, 'docs/sessions'), Math.ceil(limit / 2)),
    ].slice(0, limit);
    docEntries = buildWikiEntriesFromDocuments(files, { baseDir: projectDocs });
    minuteEntries = options.noDb ? [] : await fetchMeetingMinuteEntries(30);
  }

  const entries = [...vaultEntries, ...docEntries, ...minuteEntries].filter((entry) => entry.excerpt);
  const topics = [...new Set(entries.map((entry) => entry.topic))].sort();
  const existing = readExistingPages(outDir, topics);
  const deterministicPages = mergeWikiPages(entries, existing);
  const llm = options.llmPreview && !options.noDb && entries.length > 0
    ? await buildLlmWikiPreviews({
      entries,
      maxCalls: options.dryRun !== false ? 1 : Math.min(10, topics.length),
      llmClient: options.llmClient || hubClient.callHubLlm,
      now: options.now || new Date(),
    })
    : { enabled: false, cycleId: null, traceId: null, calls: 0, previews: [], warnings: [] };
  const pages = applyLlmPreviewToPages(deterministicPages, llm.previews);
  const sourceKeys = entries.map((entry) => `${entry.topic}:${entry.source}`);
  const duplicateRate = entries.length === 0
    ? 0
    : 1 - (new Set(sourceKeys).size / entries.length);
  const sourceVaultEntryIds = vaultEntries.map((entry) => entry.vaultEntryId).filter(Boolean);

  return {
    ok: true,
    source: 'sigma_llm_wiki_compile',
    sourceMode,
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun !== false,
    liveMutation: false,
    fileMutation: false,
    outputDir: outDir,
    state: {
      path: statePath(outDir),
      previousProcessedVaultEntryIds: state.processedVaultEntryIds.length,
      newVaultEntryIds: sourceVaultEntryIds,
      nextProcessedVaultEntryIds: nextWikiState(state, sourceVaultEntryIds).processedVaultEntryIds.length,
    },
    counts: {
      sourceFiles: files.length,
      sourceVaultEntries: vaultEntries.length,
      skippedVaultEntries: vaultSkipped.length,
      dreamingDigestCandidates: digestCandidates.length,
      dbMinutes: minuteEntries.length,
      entries: entries.length,
      topics: topics.length,
    },
    routing: {
      wikiLane: 'Y:high_value_l2_digest',
      dreamingLane: 'Z:DREAMING',
      highValueSources: HIGH_VALUE_WIKI_SOURCES,
      excludedSources: EXCLUDED_WIKI_SOURCES,
      highValuePatterns: HIGH_VALUE_WIKI_PATTERNS,
      lowValueDigestPatterns: LOW_VALUE_DIGEST_PATTERNS,
    },
    llm,
    duplicateRate,
    topics,
    pages,
  };
}

async function main() {
  const args = parseArgs();
  const initialState = readWikiState(args.outDir);
  const report = await buildLlmWikiCompileReport({
    outDir: args.outDir,
    limit: args.limit,
    noDb: args.noDb,
    legacyDocSource: args.legacyDocSource,
    dryRun: args.dryRun,
    state: initialState,
    llmPreview: args.llmPreview,
  });
  let vaultResults = [];
  if (args.write && !args.dryRun) {
    fs.mkdirSync(args.outDir, { recursive: true });
    for (const [topic, content] of Object.entries(report.pages)) {
      fs.writeFileSync(path.join(args.outDir, `${topic}.md`), content, 'utf8');
    }
    writeWikiState(args.outDir, nextWikiState(initialState, report.state.newVaultEntryIds));
    report.fileMutation = true;
  }
  if (args.writeVault) {
    vaultResults = await persistVaultPages(report.pages);
  }
  const output = { ...report, vaultResults: vaultResults.map((item) => ({ ok: item.ok, id: item.id || null, embedded: item.embedded })) };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`[llm-wiki] mode=${report.sourceMode} topics=${report.counts.topics} entries=${report.counts.entries} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[llm-wiki] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
