#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLlmWikiCompileReport,
  buildVaultWikiContentDigest,
  buildWikiEntrySetFromVaultRows,
  mergeWikiPages,
  nextWikiState,
  readWikiState,
} from './llm-wiki-compile.ts';

const rawCoords = {
  abstraction_level: 'L0',
  time_stage: 'raw',
  validation_state: 'unverified',
  prediction_state: 'none',
};

function directiveRow({
  id,
  signalId,
  createdAt,
  action = {
    content: 'luna daily metrics review',
    feedback_type: 'general_review',
  },
  rollbackSpec,
  legacyRollbackSpec,
  validationState = 'unverified',
} = {}) {
  const actionText = JSON.stringify(action);
  const payload = {
    tier: 1,
    outcome: 'signal_sent',
    action: actionText,
    directiveId: `directive-${id}`,
    principleCheckResult: JSON.stringify({ signal_id: signalId }),
  };
  if (rollbackSpec !== undefined) payload.rollbackSpec = rollbackSpec;
  return {
    id,
    title: `[sigma_directive] signal_sent ${actionText}`.slice(0, 120),
    type: 'library_record',
    source: 'sigma_directive',
    file_path: `library/sigma_directive/${id}`,
    content: [
      'signal_sent',
      actionText,
      JSON.stringify({ signal_id: signalId }),
      legacyRollbackSpec === undefined ? null : JSON.stringify(legacyRollbackSpec),
    ].filter(Boolean).join(' '),
    meta: {
      team: 'luna',
      sourceKind: 'sigma_directive',
      payload,
      libraryCoords: { ...rawCoords, validation_state: validationState },
    },
    created_at: createdAt,
    ...rawCoords,
    validation_state: validationState,
  };
}

async function main() {
  const older = directiveRow({
    id: 'row-older',
    signalId: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-07-19T23:59:59.000Z',
  });
  const newer = directiveRow({
    id: 'row-newer',
    signalId: '22222222-2222-4222-8222-222222222222',
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
  });
  const newestWhitespaceVariant = directiveRow({
    id: 'row-whitespace',
    signalId: '33333333-3333-4333-8333-333333333333',
    createdAt: '2026-07-20T00:00:01.000Z',
  });
  newestWhitespaceVariant.meta.payload.action = '  { "content": "luna daily metrics review", "feedback_type": "general_review" }  ';

  // ① unit + ② duplicate key + ⑧ real schema fixture
  assert.equal(buildVaultWikiContentDigest(older), buildVaultWikiContentDigest(newer));
  assert.equal(buildVaultWikiContentDigest(newer), buildVaultWikiContentDigest(newestWhitespaceVariant));
  const deduped = buildWikiEntrySetFromVaultRows([older, newer, newestWhitespaceVariant]);
  assert.equal(deduped.stats.sourceVaultEntries, 3);
  assert.equal(deduped.stats.contentUniqueEntries, 1);
  assert.equal(deduped.stats.contentDuplicateGroups, 1);
  assert.equal(deduped.stats.contentDuplicateRows, 2);
  assert.equal(deduped.entries[0].vaultEntryId, 'row-whitespace');
  assert.deepEqual(deduped.entries[0].vaultEntryIds.sort(), ['row-newer', 'row-older', 'row-whitespace']);

  const page = mergeWikiPages(deduped.entries).luna;
  assert.equal((page.match(/^## /gm) || []).length, 1);
  assert.match(page, /Occurrences: 3 source entries \(2 duplicates suppressed\)/);

  // ③ outlier + ④ direction: a substantive action change must not merge.
  const opposite = directiveRow({
    id: 'row-opposite',
    signalId: '44444444-4444-4444-8444-444444444444',
    createdAt: '2026-07-20T00:00:02.000Z',
    action: { content: 'disable luna daily metrics review', feedback_type: 'general_review' },
  });
  assert.notEqual(buildVaultWikiContentDigest(newer), buildVaultWikiContentDigest(opposite));
  assert.equal(buildWikiEntrySetFromVaultRows([newer, opposite]).entries.length, 2);
  const punctuationVariant = directiveRow({
    id: 'row-punctuation',
    signalId: '45454545-4545-4545-8545-454545454545',
    createdAt: '2026-07-20T00:00:02.500Z',
    action: { content: 'luna daily metrics review.', feedback_type: 'general_review' },
  });
  assert.notEqual(buildVaultWikiContentDigest(newer), buildVaultWikiContentDigest(punctuationVariant));
  assert.equal(buildWikiEntrySetFromVaultRows([newer, newer, older]).stats.sourceVaultEntries, 2);
  const semanticIdA = directiveRow({
    id: 'row-semantic-id-a',
    signalId: '46464646-4646-4646-8646-464646464646',
    createdAt: '2026-07-20T00:00:02.600Z',
    action: { content: 'inspect referenced signal', signal_id: 'semantic-A' },
  });
  const semanticIdB = directiveRow({
    id: 'row-semantic-id-b',
    signalId: '47474747-4747-4747-8747-474747474747',
    createdAt: '2026-07-20T00:00:02.700Z',
    action: { content: 'inspect referenced signal', signal_id: 'semantic-B' },
  });
  assert.notEqual(buildVaultWikiContentDigest(semanticIdA), buildVaultWikiContentDigest(semanticIdB));
  const rollbackA = directiveRow({
    id: 'row-rollback-a',
    signalId: '48484848-4848-4848-8848-484848484848',
    createdAt: '2026-07-20T00:00:02.800Z',
    rollbackSpec: { window_minutes: 15, action: 'revert' },
  });
  const rollbackB = directiveRow({
    id: 'row-rollback-b',
    signalId: '49494949-4949-4949-8949-494949494949',
    createdAt: '2026-07-20T00:00:02.900Z',
    rollbackSpec: { window_minutes: 60, action: 'revert' },
  });
  assert.notEqual(buildVaultWikiContentDigest(rollbackA), buildVaultWikiContentDigest(rollbackB));
  const legacyRollbackA = directiveRow({
    id: 'row-legacy-rollback-a',
    signalId: '50505050-5050-4050-8050-505050505050',
    createdAt: '2026-07-20T00:00:02.910Z',
    legacyRollbackSpec: { window_minutes: 15, action: 'revert' },
  });
  const legacyRollbackB = directiveRow({
    id: 'row-legacy-rollback-b',
    signalId: '51515151-5151-4151-8151-515151515151',
    createdAt: '2026-07-20T00:00:02.920Z',
    legacyRollbackSpec: { window_minutes: 60, action: 'revert' },
  });
  assert.notEqual(buildVaultWikiContentDigest(legacyRollbackA), buildVaultWikiContentDigest(legacyRollbackB));
  const legacyObjectRollbackA = directiveRow({
    id: 'row-legacy-object-rollback-a',
    signalId: '52525252-5252-4252-8252-525252525252',
    createdAt: '2026-07-20T00:00:02.930Z',
    legacyRollbackSpec: { window_minutes: 15, action: 'revert' },
  });
  const legacyObjectRollbackB = directiveRow({
    id: 'row-legacy-object-rollback-b',
    signalId: '53535353-5353-4353-8353-535353535353',
    createdAt: '2026-07-20T00:00:02.940Z',
    legacyRollbackSpec: { window_minutes: 60, action: 'revert' },
  });
  for (const row of [legacyObjectRollbackA, legacyObjectRollbackB]) {
    const signalId = JSON.parse(row.meta.payload.principleCheckResult).signal_id;
    row.meta.payload.action = {
      feedback_type: 'general_review',
      content: 'luna daily metrics review',
    };
    row.meta.payload.principleCheckResult = {
      signal_id: signalId,
      directive_id: `directive-${row.id}`,
    };
    row.content = [
      'signal_sent',
      '{"content":"luna daily metrics review","feedback_type":"general_review"}',
      `{"directive_id":"directive-${row.id}","signal_id":"${signalId}"}`,
      row.id.endsWith('-a')
        ? '{"action":"revert","window_minutes":15}'
        : '{"action":"revert","window_minutes":60}',
    ].join(' ');
  }
  assert.notEqual(
    buildVaultWikiContentDigest(legacyObjectRollbackA),
    buildVaultWikiContentDigest(legacyObjectRollbackB),
  );

  // ④ epistemic direction: conflicting validation states remain separate.
  const validated = directiveRow({
    id: 'row-validated',
    signalId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-07-20T00:00:03.000Z',
    validationState: 'validated',
  });
  assert.equal(buildVaultWikiContentDigest(newer), buildVaultWikiContentDigest(validated));
  assert.equal(buildWikiEntrySetFromVaultRows([newer, validated]).entries.length, 2);

  // ⑤ partial event: malformed/missing payload falls back to exact normalized body.
  const partialA = { ...older, id: 'partial-a', meta: '{bad-json', content: 'literal evidence UUID-A' };
  const partialB = { ...older, id: 'partial-b', meta: null, content: 'literal evidence UUID-B' };
  assert.notEqual(buildVaultWikiContentDigest(partialA), buildVaultWikiContentDigest(partialB));

  // ⑥ concurrency + ⑨ time: input order and Date/ISO forms do not alter the representative.
  const reordered = buildWikiEntrySetFromVaultRows([newestWhitespaceVariant, older, newer]);
  assert.equal(reordered.entries[0].vaultEntryId, deduped.entries[0].vaultEntryId);

  // ⑦ initial/state: empty input is safe and semantic keys stop later singleton re-append.
  const empty = buildWikiEntrySetFromVaultRows([]);
  assert.equal(empty.stats.sourceVaultEntries, 0);
  assert.equal(empty.stats.contentDuplicateRate, 0);
  const state = nextWikiState(
    { version: 1, processedVaultEntryIds: [], updatedAt: null },
    deduped.sourceVaultEntryIds,
    new Date('2026-07-20T00:00:04.000Z'),
    deduped.contentKeys,
  );
  assert.equal(state.version, 2);
  const later = directiveRow({
    id: 'row-later',
    signalId: '66666666-6666-4666-8666-666666666666',
    createdAt: '2026-07-27T00:00:00.000Z',
  });
  const incremental = buildWikiEntrySetFromVaultRows([later], {
    processedVaultEntryIds: state.processedVaultEntryIds,
    processedContentKeys: state.processedContentKeys,
  });
  assert.equal(incremental.entries.length, 0);
  assert.deepEqual(incremental.sourceVaultEntryIds, ['row-later']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-content-dedupe-'));
  const report = await buildLlmWikiCompileReport({
    outDir: path.join(tmp, 'wiki'),
    limit: 10,
    dryRun: true,
    llmPreview: false,
    state: { version: 1, processedVaultEntryIds: [], updatedAt: null },
    queryReadonly: async (_schema, sql) => {
      if (/information_schema\.columns/i.test(sql)) {
        return Object.keys(rawCoords).map((column_name) => ({ column_name }));
      }
      if (/LOWER\(COALESCE\(source/i.test(sql)) return [older, newer, newestWhitespaceVariant];
      return [];
    },
  });
  assert.equal(report.dryRun, true);
  assert.equal(report.fileMutation, false);
  assert.equal(report.counts.sourceVaultEntries, 3);
  assert.equal(report.counts.entries, 1);
  assert.equal(report.counts.contentDuplicateRows, 2);
  assert.equal(report.duplicateRate, 2 / 3);
  assert.equal(fs.existsSync(path.join(tmp, 'wiki/luna.md')), false);

  const migrationOutDir = path.join(tmp, 'wiki-v1-migration');
  assert.equal(readWikiState(path.join(tmp, 'wiki-without-state')).version, 1);
  fs.mkdirSync(migrationOutDir, { recursive: true });
  fs.writeFileSync(path.join(migrationOutDir, '.llm-wiki-state.json'), JSON.stringify({
    version: 1,
    processedVaultEntryIds: [older.id, newer.id, newestWhitespaceVariant.id],
    updatedAt: '2026-07-19T00:00:00.000Z',
  }), 'utf8');
  fs.writeFileSync(path.join(migrationOutDir, 'luna.md'), [
    '# luna wiki',
    '',
    '## polluted older copy',
    '',
    'Source: `vault-entry:row-older`',
    '',
    '## polluted newer copy',
    '',
    'Source: `vault-entry:row-newer`',
  ].join('\n'), 'utf8');
  const v1State = readWikiState(migrationOutDir);
  assert.equal(v1State.version, 1);
  const migrationReport = await buildLlmWikiCompileReport({
    outDir: migrationOutDir,
    limit: 10,
    dryRun: true,
    llmPreview: false,
    state: v1State,
    queryReadonly: async (_schema, sql) => {
      if (/information_schema\.columns/i.test(sql)) {
        return Object.keys(rawCoords).map((column_name) => ({ column_name }));
      }
      if (/LOWER\(COALESCE\(source/i.test(sql)) return [older, newer, newestWhitespaceVariant];
      return [];
    },
  });
  assert.equal(migrationReport.state.migration, 'v1_content_rebuild');
  assert.equal(migrationReport.counts.entries, 1);
  assert.equal((migrationReport.pages.luna.match(/^## /gm) || []).length, 1);
  assert.doesNotMatch(migrationReport.pages.luna, /polluted older copy/);
  assert.equal(migrationReport.state.newContentKeys.length, 1);
  await assert.rejects(
    buildLlmWikiCompileReport({
      outDir: migrationOutDir,
      limit: 10,
      dryRun: true,
      llmPreview: false,
      state: v1State,
      queryReadonly: async (_schema, sql) => {
        if (/information_schema\.columns/i.test(sql)) return [];
        throw new Error('fixture_source_unavailable');
      },
    }),
    /llm_wiki_v1_rebuild_source_failed:fixture_source_unavailable/,
  );
  await assert.rejects(
    buildLlmWikiCompileReport({
      outDir: migrationOutDir,
      limit: 10,
      dryRun: true,
      llmPreview: false,
      state: v1State,
      queryReadonly: async (_schema, sql) => {
        if (/information_schema\.columns/i.test(sql)) throw new Error('fixture_schema_unavailable');
        return [older, newer, newestWhitespaceVariant];
      },
    }),
    /llm_wiki_v1_rebuild_source_failed:fixture_schema_unavailable/,
  );

  console.log(JSON.stringify({ ok: true, checks: 45, boundaries: 9 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
