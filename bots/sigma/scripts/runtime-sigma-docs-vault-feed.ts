#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { attachSourceRefToMeta } from '../shared/source-ref.ts';
import { createVaultEmbedding, VaultManager } from '../vault/vault-manager.ts';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool'));

const DEFAULT_PROJECT_DOCS = path.join(os.homedir(), 'project-docs/ai-agent-system');
const DEFAULT_HANDOFF_DIR = path.join(DEFAULT_PROJECT_DOCS, 'handoff');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, Math.floor(safe)));
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function firstHeading(content, fallback) {
  return String(content || '').match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback;
}

function safePathPart(value) {
  return String(value || 'unknown')
    .replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'unknown';
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

export function walkMarkdown(dir, sinceMs, limit) {
  const files = [];
  function visit(current) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.md')) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= sinceMs) files.push({ file: full, stat });
      }
    }
  }
  visit(dir);
  return files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, limit);
}

export function buildDocsVaultCandidates({ handoffFiles = [], meetingMinutes = [], baseDir = DEFAULT_PROJECT_DOCS } = {}) {
  const handoffCandidates = [];
  for (const item of handoffFiles || []) {
    const file = typeof item === 'string' ? item : item.file;
    if (!file || !fs.existsSync(file)) continue;
    const content = cleanText(fs.readFileSync(file, 'utf8'));
    if (!content) continue;
    const relative = path.relative(baseDir, file).replace(/\\/g, '/');
    const hash = contentHash(content);
    handoffCandidates.push({
      sourceKind: 'handoff',
      sourceId: `handoff:${relative}:${hash.slice(0, 12)}`,
      title: `[handoff] ${firstHeading(content, path.basename(file, '.md'))}`,
      type: 'handoff_doc',
      content,
      tags: ['sigma-library', 'handoff', 'docs'],
      filePath: `library/handoff/${safePathPart(relative)}-${hash.slice(0, 12)}`,
      source: 'handoff',
      meta: attachSourceRefToMeta({
        sourceKind: 'handoff',
        sourcePath: relative,
        contentHash: hash,
        modifiedAt: new Date((typeof item === 'string' ? fs.statSync(file) : item.stat).mtimeMs).toISOString(),
      }, { team: 'docs', table: 'project_docs.handoff', id: relative }),
    });
  }

  const minuteCandidates = (meetingMinutes || [])
    .map((row) => {
      const content = cleanText(row.content || row.full_text || row.summary || '');
      if (!content) return null;
      const sessionId = String(row.session_id || row.meeting_id || 'unknown');
      const seq = String(row.seq ?? row.id ?? shortHash(content).slice(0, 8));
      const hash = contentHash(content);
      return {
        sourceKind: 'meeting_minutes',
        sourceId: `meeting_minutes:${sessionId}:${seq}:${hash.slice(0, 12)}`,
        title: `[meeting_minutes] ${sessionId} #${seq} ${row.speaker || row.agent || row.role || ''}`.trim(),
        type: 'meeting_minutes',
        content,
        tags: ['sigma-library', 'meeting_minutes', 'luna', row.role || row.agenda_key || 'minute'].filter(Boolean),
        filePath: `library/meeting_minutes/${safePathPart(sessionId)}/${safePathPart(seq)}-${hash.slice(0, 12)}`,
        source: 'meeting_minutes',
        meta: attachSourceRefToMeta({
          sourceKind: 'meeting_minutes',
          sessionId,
          seq,
          agendaKey: row.agenda_key || null,
          speaker: row.speaker || row.agent || null,
          role: row.role || null,
          contentHash: hash,
          createdAt: row.created_at || null,
        }, { team: 'luna', table: 'investment.luna_meeting_minutes', id: `${sessionId}:${seq}` }),
      };
    })
    .filter(Boolean);

  return [...handoffCandidates, ...minuteCandidates];
}

async function fetchMeetingMinutes({ sinceHours, limit, queryReadonly = pgPool.queryReadonly || pgPool.query }) {
  try {
    const rows = await queryReadonly('investment', `
      SELECT session_id, seq, agenda_key, speaker, role, content, meta, created_at
      FROM investment.luna_meeting_minutes
      WHERE created_at >= NOW() - ($1 || ' hours')::INTERVAL
      ORDER BY created_at DESC
      LIMIT $2
    `, [String(sinceHours), limit]);
    return Array.isArray(rows) ? rows : rows?.rows ?? [];
  } catch (error) {
    return { error: error?.message || String(error), rows: [] };
  }
}

export async function runSigmaDocsVaultFeed(options = {}) {
  const sinceHours = boundedNumber(options.sinceHours, 24 * 7, 1, 24 * 60);
  const limit = boundedNumber(options.limit, 80, 1, 500);
  const handoffDir = options.handoffDir || DEFAULT_HANDOFF_DIR;
  const baseDir = options.baseDir || DEFAULT_PROJECT_DOCS;
  const effectiveDryRun = options.dryRun !== false || options.write !== true;
  const sinceMs = Date.now() - sinceHours * 3600 * 1000;

  const handoffFiles = walkMarkdown(handoffDir, sinceMs, limit);
  const minutesResult = options.noDb
    ? []
    : await fetchMeetingMinutes({ sinceHours, limit, queryReadonly: options.queryReadonly || pgPool.queryReadonly || pgPool.query });
  const meetingMinutes = Array.isArray(minutesResult) ? minutesResult : minutesResult.rows;
  const warnings = Array.isArray(minutesResult) ? [] : [`meeting_minutes:${minutesResult.error}`];
  const candidates = buildDocsVaultCandidates({ handoffFiles, meetingMinutes, baseDir });

  const embeddingProbeRecord = candidates[0] || null;
  const embeddingProbe = embeddingProbeRecord && options.sampleEmbedding !== false
    ? await createVaultEmbedding(embeddingProbeRecord.content)
    : { embedding: null, dim: null, warning: 'embedding_probe_skipped' };

  const manager = effectiveDryRun ? null : new VaultManager();
  const results = [];
  if (manager) {
    for (const candidate of candidates) {
      const persisted = await manager.addToInbox(candidate);
      results.push({
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        filePath: candidate.filePath,
        ok: persisted.ok,
        id: persisted.id || null,
        embedded: persisted.embedded,
        embeddingDim: persisted.embeddingDim ?? null,
        embeddingWarning: persisted.embeddingWarning || null,
        message: persisted.message,
      });
    }
  }

  const failed = results.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    dryRun: effectiveDryRun,
    sinceHours,
    limit,
    source: {
      handoffFiles: handoffFiles.length,
      meetingMinutes: meetingMinutes.length,
      warnings,
    },
    candidates: candidates.length,
    candidatesBySource: countBy(candidates, (item) => item.sourceKind),
    embeddingProbe: {
      sourceKind: embeddingProbeRecord?.sourceKind || null,
      dim: embeddingProbe.dim,
      embedded: Boolean(embeddingProbe.embedding),
      warning: embeddingProbe.warning || null,
    },
    persisted: {
      attempted: results.length,
      ok: results.filter((item) => item.ok).length,
      failed: failed.length,
      embedded: results.filter((item) => item.embedded).length,
      bySource: countBy(results.filter((item) => item.ok), (item) => item.sourceKind),
      embeddingWarnings: results.filter((item) => item.embeddingWarning).slice(0, 10),
      failures: failed.slice(0, 10),
    },
    sample: candidates.slice(0, 3).map((item) => ({
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      title: item.title,
      filePath: item.filePath,
      text: item.content.slice(0, 220),
    })),
    generatedAt: new Date().toISOString(),
    safety: {
      defaultDryRun: true,
      dbWriteRequiresWriteAndNoDryRun: true,
      writesOnlySigmaVaultEntries: true,
      liveImpact: false,
    },
  };
}

async function main() {
  const json = hasFlag('json');
  const write = hasFlag('write');
  const noDryRun = hasFlag('no-dry-run');
  const result = await runSigmaDocsVaultFeed({
    sinceHours: boundedNumber(argValue('since-hours', '168'), 168, 1, 24 * 60),
    limit: boundedNumber(argValue('limit', '80'), 80, 1, 500),
    handoffDir: argValue('handoff-dir', DEFAULT_HANDOFF_DIR),
    dryRun: !noDryRun,
    write,
    noDb: hasFlag('no-db'),
    sampleEmbedding: !hasFlag('no-sample-embedding'),
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-docs-vault-feed] dryRun=${result.dryRun} candidates=${result.candidates} persisted=${result.persisted.ok}/${result.persisted.attempted}`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
