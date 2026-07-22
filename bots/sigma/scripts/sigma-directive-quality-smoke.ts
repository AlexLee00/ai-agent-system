#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { formatSigmaDirectiveText } from '../ts/lib/library-data-source.ts';
import { entryForRecord } from './runtime-sigma-luna-vault-feed.ts';
import {
  buildLlmWikiCompileReport,
  buildWikiEntrySetFromVaultRows,
  mergeWikiPages,
} from './llm-wiki-compile.ts';
import {
  VaultManager,
  buildVaultNormalizedContentMd5,
  buildVaultUpsertContentMd5,
} from '../vault/vault-manager.ts';

const BASE_ACTION = {
  schema_version: 'sigma.directive.v1',
  target_team: 'luna',
  owner: 'luna',
  purpose: '거래 운영 지표를 점검하고 임계 이탈 시 다음 조치를 보고하세요.',
  content: '거래 운영 지표를 점검하고 임계 이탈 시 다음 조치를 보고하세요.',
  feedback_type: 'general_review',
  kpis: [
    { name: 'trades_7d', current_value: 4, threshold: { operator: '>=', value: 1 }, unit: 'count' },
    { name: 'traded_usdt_7d', current_value: 1250.5, threshold: { operator: '>=', value: 0 }, unit: 'USDT' },
    { name: 'live_positions', current_value: 2, threshold: { operator: '<=', value: 5 }, unit: 'count' },
  ],
  cadence: { measure_every: 'P1D', report_every: 'P1D' },
  report_format: {
    format: 'markdown',
    required_sections: ['kpi_snapshot', 'threshold_breaches', 'next_actions'],
  },
};

function directiveRecord({
  sourceId,
  directiveId,
  signalId,
  action = BASE_ACTION,
  rollbackSpec = { mode: 'advisory_only', directive_id: directiveId },
} = {}) {
  return {
    team: 'luna',
    agent: 'sigma',
    sourceKind: 'sigma_directive',
    sourceId,
    createdAt: '2026-07-22T00:00:00.000Z',
    text: formatSigmaDirectiveText({ team: 'luna', tier: 1, outcome: 'signal_sent', action }),
    piiRedactedText: formatSigmaDirectiveText({ team: 'luna', tier: 1, outcome: 'signal_sent', action }),
    redactions: [],
    contentHash: sourceId.padEnd(64, '0').slice(0, 64),
    constitutionAllowed: true,
    constitutionCritiques: [],
    payload: {
      tier: 1,
      outcome: 'signal_sent',
      action,
      principleCheckResult: { accepted: true },
      rollbackSpec,
      transport: { directiveId, signalId },
    },
  };
}

function makeMockPgPool() {
  const rows = [];
  const audits = [];
  const calls = [];
  let insertCount = 0;
  let idSequence = 1;
  const pgPool = {
    rows,
    audits,
    calls,
    get insertCount() { return insertCount; },
    async query(schema, sql, params = []) {
      calls.push({ schema, sql, params });
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('information_schema.columns')) return [];
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return [];
      if (normalized.startsWith('SELECT id, title, type, content, source, file_path')) {
        if (normalized.includes('file_path = $1')) {
          const row = rows.find((candidate) => candidate.file_path === params[0]);
          return row ? [row] : [];
        }
        if (normalized.includes("source = 'sigma_directive'")) return [...rows];
        const row = rows.find((candidate) => candidate.meta?.normalizedContentMd5 === params[0]);
        return row ? [row] : [];
      }
      if (normalized.startsWith('INSERT INTO sigma.vault_entries')) {
        insertCount += 1;
        const row = {
          id: `directive-entry-${idSequence++}`,
          title: params[0],
          type: params[1],
          content: params[2],
          tags: params[3],
          para_category: 'inbox',
          file_path: params[4],
          source: params[5],
          meta: JSON.parse(params[6] || '{}'),
          created_at: '2026-07-22T00:00:00.000Z',
        };
        rows.push(row);
        return [{ id: row.id }];
      }
      if (normalized.startsWith('UPDATE sigma.vault_entries SET meta =')) {
        const row = rows.find((candidate) => candidate.id === params[0]);
        if (!row) return [];
        row.meta = JSON.parse(params[1] || '{}');
        return [row];
      }
      if (normalized.startsWith('INSERT INTO sigma.vault_audit')) {
        audits.push({ entryId: params[0], action: params[1], reasoning: params[6] });
        return [];
      }
      throw new Error(`unexpected_query:${normalized.slice(0, 160)}`);
    },
    async transaction(schema, callback) {
      return callback({
        query: async (sql, params = []) => {
          const result = await pgPool.query(schema, sql, params);
          return { rows: result, rowCount: result.length };
        },
      });
    },
  };
  return pgPool;
}

function withAction(record, action) {
  return directiveRecord({
    sourceId: record.sourceId,
    directiveId: record.payload.transport.directiveId,
    signalId: record.payload.transport.signalId,
    action,
    rollbackSpec: record.payload.rollbackSpec,
  });
}

async function main() {
  const firstRecord = directiveRecord({
    sourceId: 'row-a',
    directiveId: 'directive-a',
    signalId: 'signal-a',
  });
  const repeatRecord = directiveRecord({
    sourceId: 'row-b',
    directiveId: 'directive-b',
    signalId: 'signal-b',
  });
  const firstEntry = entryForRecord(firstRecord);
  const repeatEntry = entryForRecord(repeatRecord);

  // 1. Transport identities live in metadata/source_ref and do not change the semantic upsert key.
  assert.equal(firstEntry.meta.source_ref.table, 'public.sigma_v2_directive_audit');
  assert.equal(firstEntry.meta.source_ref.id, 'row-a');
  assert.equal(firstEntry.meta.payload.transport.signalId, 'signal-a');
  assert.doesNotMatch(firstEntry.content, /signal-a|directive-a/);
  assert.equal(buildVaultUpsertContentMd5(firstEntry), buildVaultUpsertContentMd5(repeatEntry));

  // 2. JSON key order and whitespace are semantic no-ops.
  const reorderedAction = {
    report_format: BASE_ACTION.report_format,
    cadence: BASE_ACTION.cadence,
    kpis: BASE_ACTION.kpis,
    feedback_type: BASE_ACTION.feedback_type,
    content: `  ${BASE_ACTION.content}  `,
    purpose: `  ${BASE_ACTION.purpose}  `,
    owner: 'luna',
    target_team: 'luna',
    schema_version: 'sigma.directive.v1',
  };
  assert.equal(
    buildVaultUpsertContentMd5(firstEntry),
    buildVaultUpsertContentMd5(entryForRecord(withAction(repeatRecord, reorderedAction))),
  );

  // 3. Purpose direction changes must not merge.
  assert.notEqual(
    buildVaultUpsertContentMd5(firstEntry),
    buildVaultUpsertContentMd5(entryForRecord(withAction(repeatRecord, {
      ...BASE_ACTION,
      purpose: '거래를 즉시 중단하세요.',
      content: '거래를 즉시 중단하세요.',
    }))),
  );

  // 4. A signal_id inside the action is semantic and must remain distinct.
  assert.notEqual(
    buildVaultUpsertContentMd5(entryForRecord(withAction(firstRecord, { ...BASE_ACTION, signal_id: 'semantic-a' }))),
    buildVaultUpsertContentMd5(entryForRecord(withAction(repeatRecord, { ...BASE_ACTION, signal_id: 'semantic-b' }))),
  );

  // 5. Rollback transport IDs are ignored, while rollback policy remains semantic.
  const rollbackRepeat = directiveRecord({
    sourceId: 'row-c', directiveId: 'directive-c', signalId: 'signal-c',
    rollbackSpec: { mode: 'advisory_only', directive_id: 'transport-c' },
  });
  const rollbackChanged = directiveRecord({
    sourceId: 'row-d', directiveId: 'directive-d', signalId: 'signal-d',
    rollbackSpec: { mode: 'revert', window_minutes: 30, directive_id: 'transport-d' },
  });
  assert.equal(buildVaultUpsertContentMd5(firstEntry), buildVaultUpsertContentMd5(entryForRecord(rollbackRepeat)));
  assert.notEqual(buildVaultUpsertContentMd5(firstEntry), buildVaultUpsertContentMd5(entryForRecord(rollbackChanged)));

  // 6. Numeric threshold changes are substantive.
  const thresholdChanged = structuredClone(BASE_ACTION);
  thresholdChanged.kpis[0].threshold.value = 2;
  assert.notEqual(
    buildVaultUpsertContentMd5(firstEntry),
    buildVaultUpsertContentMd5(entryForRecord(withAction(repeatRecord, thresholdChanged))),
  );

  // 7. Current metric changes permit a fresh directive.
  const metricChanged = structuredClone(BASE_ACTION);
  metricChanged.kpis[0].current_value = 5;
  assert.notEqual(
    buildVaultUpsertContentMd5(firstEntry),
    buildVaultUpsertContentMd5(entryForRecord(withAction(repeatRecord, metricChanged))),
  );

  // 8. Adjacent feeds retain the existing title+content contract.
  const adjacentA = { source: 'luna_learned_bias', title: 'bias-a', content: 'same body', meta: {} };
  const adjacentB = { source: 'luna_learned_bias', title: 'bias-b', content: 'same body', meta: {} };
  assert.equal(buildVaultUpsertContentMd5(adjacentA), buildVaultNormalizedContentMd5(adjacentA));
  assert.notEqual(buildVaultUpsertContentMd5(adjacentA), buildVaultUpsertContentMd5(adjacentB));

  // 9. Malformed legacy payloads fall back to content and never collapse unrelated rows.
  const malformedA = { source: 'sigma_directive', title: 'legacy-a', content: 'first legacy directive', meta: {} };
  const malformedB = { source: 'sigma_directive', title: 'legacy-b', content: 'second legacy directive', meta: {} };
  assert.notEqual(buildVaultUpsertContentMd5(malformedA), buildVaultUpsertContentMd5(malformedB));

  const pgPool = makeMockPgPool();
  const manager = new VaultManager({
    pgPool,
    embeddingFactory: async () => ({ embedding: null, dim: null, warning: 'fixture_embedding_disabled' }),
  });
  const first = await manager.addToInbox(firstEntry);
  const insertsBeforeRepeat = pgPool.insertCount;
  const repeated = await manager.addToInbox(repeatEntry);
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.id, first.id);
  assert.equal(pgPool.insertCount - insertsBeforeRepeat, 0, 'same-meaning re-emission must create zero vault rows');
  assert.equal(pgPool.rows.length, 1);

  const wikiRow = {
    ...pgPool.rows[0],
    meta: {
      ...pgPool.rows[0].meta,
      libraryCoords: {
        abstraction_level: 'L0',
        time_stage: 'raw',
        validation_state: 'unverified',
        prediction_state: 'none',
      },
    },
  };
  const wikiEntries = buildWikiEntrySetFromVaultRows([wikiRow]).entries;
  const lunaPage = mergeWikiPages(wikiEntries).luna;
  assert.match(lunaPage, /Target team: luna/);
  assert.match(lunaPage, /KPI: trades_7d/);
  assert.match(lunaPage, /Threshold: >= 1/);
  assert.match(lunaPage, /Cadence: measure P1D; report P1D/);
  assert.match(lunaPage, /Report: markdown/);

  const dryRunReport = await buildLlmWikiCompileReport({
    outDir: `/tmp/sigma-directive-quality-${process.pid}`,
    limit: 10,
    dryRun: true,
    llmPreview: false,
    state: {
      version: 3,
      processedVaultEntryIds: [],
      processedContentKeys: [],
      updatedAt: null,
    },
    queryReadonly: async (_schema, sql) => {
      if (/information_schema\.columns/i.test(sql)) {
        return [
          'abstraction_level',
          'time_stage',
          'validation_state',
          'prediction_state',
          'prediction_horizon',
        ].map((column_name) => ({ column_name }));
      }
      if (/LOWER\(COALESCE\(source/i.test(sql)) return [wikiRow];
      return [];
    },
  });
  assert.equal(dryRunReport.dryRun, true);
  assert.equal(dryRunReport.liveMutation, false);
  assert.equal(dryRunReport.fileMutation, false);
  assert.match(dryRunReport.pages.luna, /KPI: trades_7d/);

  console.log(JSON.stringify({
    ok: true,
    status: 'sigma_directive_quality_smoke_passed',
    boundaries: 9,
    firstVaultRows: 1,
    repeatNewVaultRows: pgPool.insertCount - insertsBeforeRepeat,
    wikiQualityMarkers: 5,
    wikiDryRun: true,
    liveMutation: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
