#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectPredictionHint,
  inferRawLibraryCoords,
  normalizeLibraryCoords,
} from '../shared/library-coords.ts';
import { classify } from '../vault/para-classifier.ts';
import {
  VaultManager,
  buildVaultNormalizedContentMd5,
  buildVaultRawHash,
} from '../vault/vault-manager.ts';
import {
  inspectSigmaCoordSchema,
  SIGMA_COORD_COLUMNS,
} from './runtime-sigma-coord-schema-bootstrap.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeMockPgPool({ coordColumns = [] } = {}) {
  const rowsByFilePath = new Map();
  const audits = [];
  let idSeq = 1;
  const calls = [];
  let transactionQueue = Promise.resolve();
  const pgPool = {
    rowsByFilePath,
    audits,
    calls,
    async query(schema, sql, params = []) {
      calls.push({ schema, sql, params });
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('information_schema.columns')) {
        return coordColumns.map((column_name) => ({ column_name }));
      }
      if (normalized.includes('pg_constraint')) {
        return [];
      }
      if (normalized.startsWith('SELECT id, title, type, content, source, file_path')) {
        if (normalized.includes("normalizedContentMd5")) {
          const row = [...rowsByFilePath.values()].find((candidate) => candidate.meta?.normalizedContentMd5 === params[0]);
          return row ? [row] : [];
        }
        const row = rowsByFilePath.get(params[0]);
        return row ? [row] : [];
      }
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return [];
      if (normalized.startsWith('INSERT INTO sigma.vault_entries')) {
        const meta = JSON.parse(params[6] || '{}');
        const row = {
          id: `entry-${idSeq++}`,
          title: params[0],
          type: params[1],
          content: params[2],
          tags: params[3],
          para_category: 'inbox',
          file_path: params[4],
          source: params[5],
          meta,
        };
        if (row.file_path && rowsByFilePath.has(row.file_path)) return [];
        rowsByFilePath.set(row.file_path || row.id, row);
        return [{ id: row.id }];
      }
      if (normalized.startsWith('UPDATE sigma.vault_entries SET meta =')) {
        const row = [...rowsByFilePath.values()].find((candidate) => candidate.id === params[0]);
        if (!row) return [];
        row.meta = JSON.parse(params[1] || '{}');
        return [row];
      }
      if (normalized.startsWith('INSERT INTO sigma.vault_audit')) {
        audits.push({
          entryId: params[0],
          action: params[1],
          fromCategory: params[2],
          toCategory: params[3],
          classifier: params[4],
          confidence: params[5],
          reasoning: params[6],
          applied: params[7],
          dryRun: params[8],
        });
        return [];
      }
      throw new Error(`unexpected query:${normalized.slice(0, 120)}`);
    },
    async queryReadonly(schema, sql, params = []) {
      return this.query(schema, sql, params);
    },
    async transaction(schema, callback) {
      const execute = async () => callback({
        query: async (sql, params = []) => {
          const rows = await pgPool.query(schema, sql, params);
          return { rows, rowCount: rows.length };
        },
      });
      const result = transactionQueue.then(execute, execute);
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
    },
  };
  return pgPool;
}

async function assertCoordUtilities() {
  assert.equal(detectPredictionHint('다음 주 시장 전망과 목표 가격'), true);
  const forward = inferRawLibraryCoords({
    title: 'Luna 전망',
    content: '다음 주 목표 수익률을 예상한다.',
    now: new Date('2026-07-03T00:00:00.000Z'),
  });
  assert.equal(forward.abstraction_level, 'L0');
  assert.equal(forward.time_stage, 'raw');
  assert.equal(forward.validation_state, 'unverified');
  assert.equal(forward.prediction_state, 'forward');
  assert.match(forward.prediction_horizon, /^2026-07-10T/);

  const normalized = normalizeLibraryCoords({
    abstraction_level: 'bad',
    time_stage: 'digest',
    validation_state: 'validated',
    prediction_state: 'none',
  });
  assert.equal(normalized.abstraction_level, 'L0');
  assert.equal(normalized.time_stage, 'digest');
  assert.equal(normalized.validation_state, 'validated');
}

async function assertClassifierCoords() {
  const result = await classify('시장 전망 메모', '다음 달 수요를 예상한다.', { useLlm: false });
  assert.equal(result.classifier, 'rule');
  assert.equal(result.libraryCoords.prediction_state, 'forward');
  assert.ok(result.libraryCoords.prediction_horizon);
}

async function assertMigrationMarkers() {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/20260703000001_sigma_coord_schema.sql'), 'utf8');
  for (const column of SIGMA_COORD_COLUMNS) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'));
  assert.equal(/\bCREATE\s+TABLE\b/i.test(sql), false);
  assert.match(sql, /CHECK \(abstraction_level IS NULL OR abstraction_level IN/i);
}

async function assertBootstrapReadOnly() {
  const pgPool = makeMockPgPool({ coordColumns: ['abstraction_level', 'time_stage'] });
  const report = await inspectSigmaCoordSchema({ queryReadonly: pgPool.queryReadonly.bind(pgPool) });
  assert.deepEqual(report.missingColumns, ['validation_state', 'prediction_state', 'prediction_horizon']);
}

async function assertVaultManagerRawImmutability() {
  const pgPool = makeMockPgPool();
  const manager = new VaultManager({
    pgPool,
    embeddingFactory: async () => ({ embedding: null, dim: null, warning: 'mock_embedding_disabled' }),
  });

  const first = await manager.addToInbox({
    title: 'Luna Forecast',
    type: 'note',
    content: '다음 주 진입 후보를 예상한다.',
    filePath: 'library/luna/raw.md',
    source: 'smoke',
  });
  assert.equal(first.ok, true);
  const original = pgPool.rowsByFilePath.get('library/luna/raw.md');
  assert.equal(original.title, 'Luna Forecast');
  assert.equal(original.meta.libraryCoords.prediction_state, 'forward');
  assert.equal(original.meta.rawContentHash, buildVaultRawHash({
    title: 'Luna Forecast',
    type: 'note',
    content: '다음 주 진입 후보를 예상한다.',
    filePath: 'library/luna/raw.md',
    source: 'smoke',
  }, 'library/luna/raw.md'));

  const duplicate = await manager.addToInbox({
    title: 'Luna Forecast',
    type: 'note',
    content: '다음 주 진입 후보를 예상한다.',
    filePath: 'library/luna/raw.md',
    source: 'smoke',
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(pgPool.audits.some((item) => item.action === 'deduped'), true);

  const revised = await manager.addToInbox({
    title: 'Luna Forecast Updated',
    type: 'note',
    content: '다음 달 진입 후보를 다시 예상한다.',
    filePath: 'library/luna/raw.md',
    source: 'smoke',
  });
  assert.notEqual(revised.id, first.id);
  const revision = [...pgPool.rowsByFilePath.values()].find((row) => String(row.file_path).includes('#rev-'));
  assert.ok(revision);
  assert.equal(revision.meta.rawRevisionOf, first.id);
  assert.equal(revision.meta.rawOriginalFilePath, 'library/luna/raw.md');
  assert.equal(pgPool.rowsByFilePath.get('library/luna/raw.md').content, '다음 주 진입 후보를 예상한다.');
  assert.equal(pgPool.audits.some((item) => item.action === 'revised'), true);
  assert.equal(pgPool.calls.some((call) => /DO UPDATE SET/i.test(call.sql)), false);
  assert.equal(pgPool.calls.some((call) => /abstraction_level/.test(call.sql) && /INSERT INTO sigma\.vault_entries/.test(call.sql)), false);
}

async function assertVaultManagerNormalizedUpsert() {
  const pgPool = makeMockPgPool();
  let embeddingCalls = 0;
  const makeManager = () => new VaultManager({
    pgPool,
    embeddingFactory: async () => {
      embeddingCalls += 1;
      return { embedding: null, dim: null, warning: 'mock_embedding_disabled' };
    },
  });
  const first = await makeManager().addToInbox({
    title: 'Lecture Note',
    content: 'one\ntwo',
    filePath: 'feeds/docs/1',
    source: 'docs',
    meta: { source_ref: { team: 'docs', table: 'lessons', id: '1' } },
  });
  const whitespaceDuplicate = await makeManager().addToInbox({
    title: ' Lecture   Note ',
    content: 'one   two',
    filePath: 'feeds/team/2',
    source: 'team',
    meta: { source_ref: { team: 'team', table: 'lessons', id: '2' } },
  });
  assert.equal(whitespaceDuplicate.id, first.id);
  assert.equal(embeddingCalls, 1, 'preflight normalized duplicate should skip embedding');
  assert.equal(pgPool.rowsByFilePath.size, 1);
  assert.equal(
    pgPool.rowsByFilePath.get('feeds/docs/1').meta.normalizedContentMd5,
    buildVaultNormalizedContentMd5({ title: 'Lecture Note', content: 'one\ntwo' }),
  );
  assert.deepEqual(pgPool.rowsByFilePath.get('feeds/docs/1').meta.source_refs, [
    { team: 'docs', table: 'lessons', id: '1' },
    { team: 'team', table: 'lessons', id: '2' },
  ]);
  assert.deepEqual(pgPool.rowsByFilePath.get('feeds/docs/1').meta.provenance_aliases, [
    { source: 'docs', filePath: 'feeds/docs/1', sourceRef: { team: 'docs', table: 'lessons', id: '1' } },
    { source: 'team', filePath: 'feeds/team/2', sourceRef: { team: 'team', table: 'lessons', id: '2' } },
  ]);

  const concurrent = await Promise.all([
    makeManager().addToInbox({
      title: 'Concurrent',
      content: 'same body',
      filePath: 'feeds/claude/1',
      source: 'claude',
      meta: { source_ref: { team: 'claude', table: 'outcomes', id: '1' } },
    }),
    makeManager().addToInbox({
      title: 'Concurrent',
      content: 'same\nbody',
      filePath: 'feeds/luna/1',
      source: 'luna',
      meta: { source_ref: { team: 'luna', table: 'outcomes', id: '2' } },
    }),
  ]);
  assert.equal(concurrent[0].id, concurrent[1].id);
  assert.equal([...pgPool.rowsByFilePath.values()].filter((row) => row.title === 'Concurrent').length, 1);
  assert.equal(pgPool.calls.some((call) => /pg_advisory_xact_lock/i.test(call.sql)), true);
  assert.equal(
    pgPool.calls.filter((call) => /pg_advisory_xact_lock/i.test(call.sql)).every((call) => String(call.params[0]).startsWith('sigma-vault-content:')),
    true,
  );
  const concurrentRow = [...pgPool.rowsByFilePath.values()].find((row) => row.title === 'Concurrent');
  assert.deepEqual(concurrentRow.meta.source_refs, [
    { team: 'claude', table: 'outcomes', id: '1' },
    { team: 'luna', table: 'outcomes', id: '2' },
  ]);

  const nearDuplicate = await makeManager().addToInbox({
    title: 'Concurrent',
    content: 'same body.',
    filePath: 'feeds/hub/1',
    source: 'hub-llm',
  });
  assert.notEqual(nearDuplicate.id, concurrent[0].id);
}

async function main() {
  await assertCoordUtilities();
  await assertClassifierCoords();
  await assertMigrationMarkers();
  await assertBootstrapReadOnly();
  await assertVaultManagerRawImmutability();
  await assertVaultManagerNormalizedUpsert();
  console.log(JSON.stringify({ ok: true, smoke: 'sigma-coord-schema', checks: 25 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
