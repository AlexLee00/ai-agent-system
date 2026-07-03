#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWikiEntriesFromDocuments,
  buildWikiEntrySetFromVaultRows,
  mergeWikiPages,
  buildLlmWikiCompileReport,
  classifyVaultWikiSource,
  parseArgs,
} from './llm-wiki-compile.ts';

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-wiki-smoke-'));
  const handoff = path.join(tmp, 'handoff');
  fs.mkdirSync(handoff, { recursive: true });
  const hubFile = path.join(handoff, 'HANDOFF_HUB.md');
  const lunaFile = path.join(handoff, 'HANDOFF_LUNA.md');
  fs.writeFileSync(hubFile, '# Hub routing trace\n\nHub resource-api cycle trace and ops-mcp evidence.', 'utf8');
  fs.writeFileSync(lunaFile, '# Luna risk gate\n\nLuna capital risk, KIS, and Binance shadow promotion notes.', 'utf8');

  const entries = buildWikiEntriesFromDocuments([hubFile, lunaFile], { baseDir: tmp });
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.title === 'Hub routing trace').topic, 'hub');
  assert.equal(entries.find((entry) => entry.title === 'Luna risk gate').topic, 'luna');

  const pages = mergeWikiPages(entries, {
    hub: '# hub wiki\n\n## Existing\n\nSource: `handoff/HANDOFF_HUB.md`\n\nold',
  });
  assert.equal((pages.hub.match(/Source:/g) || []).length, 1, 'hub source should dedupe');
  assert.match(pages.luna, /Luna capital risk/);

  const report = await buildLlmWikiCompileReport({
    projectDocs: tmp,
    outDir: path.join(tmp, 'wiki'),
    limit: 10,
    noDb: true,
    dryRun: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.liveMutation, false);
  assert.ok(report.counts.entries >= 2);
  assert.ok(report.topics.includes('hub'));
  assert.ok(report.topics.includes('luna'));
  assert.equal(fs.existsSync(path.join(tmp, 'wiki/hub.md')), false, 'dry-run must not write files');
  const unsafeVaultArgs = parseArgs(['--write-vault', '--no-dry-run']);
  assert.equal(unsafeVaultArgs.dryRun, true, 'vault-only request without --write remains dry-run');
  assert.equal(unsafeVaultArgs.writeVault, false, 'vault write requires --write and --no-dry-run');
  const explicitVaultArgs = parseArgs(['--write', '--write-vault', '--no-dry-run']);
  assert.equal(explicitVaultArgs.dryRun, false);
  assert.equal(explicitVaultArgs.writeVault, true);

  const highValueRow = {
    id: 'hv-1',
    title: 'luna_review weekly risk note',
    type: 'luna_review',
    source: 'luna_review',
    file_path: 'library/luna_review/weekly.md',
    content: 'Luna risk gate review and capital policy evidence.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'none' } },
    created_at: '2026-07-03T00:00:00.000Z',
  };
  const lowValueRow = {
    id: 'lv-1',
    title: 'blog_comment neighbor thanks',
    type: 'blog_comment',
    source: 'blo',
    file_path: 'library/blo/comment/action/1',
    content: '감사합니다. 좋은 글입니다.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
    created_at: '2026-07-03T00:00:00.000Z',
  };
  const handoffWithBlogMention = {
    id: 'hf-1',
    title: 'handoff mentions blog_comment cleanup',
    type: 'handoff_doc',
    source: 'handoff',
    file_path: 'library/handoff/HANDOFF_BLOG_CLEANUP.md',
    content: 'handoff source can mention blog_comment cleanup without being demoted from the wiki lane.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'observed', prediction_state: 'none' } },
    created_at: '2026-07-03T00:00:00.000Z',
  };
  const pollutedBlogRow = {
    id: 'blo-1',
    title: 'review라는 단어가 들어간 블로그 댓글',
    type: 'blog_comment',
    source: 'blo',
    file_path: 'library/blo/comment/inbound/1',
    content: 'luna_review handoff reflexion marker should not promote blo content to wiki.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
  };
  const hubAlarmRow = {
    id: 'ha-1',
    title: 'handoff marker in hub alarm',
    type: 'hub_alarm',
    source: 'hub_alarm',
    file_path: 'library/hub_alarm/1',
    content: 'handoff marker should not promote hub_alarm to wiki.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
  };
  const neutralRow = {
    id: 'nt-1',
    title: 'ordinary raw note',
    type: 'note',
    source: 'sigma',
    file_path: 'library/misc/raw.md',
    content: 'A raw note about ordinary workspace maintenance.',
    meta: { libraryCoords: { abstraction_level: 'L0', time_stage: 'raw', validation_state: 'unverified', prediction_state: 'none' } },
  };
  const wikiSet = buildWikiEntrySetFromVaultRows([highValueRow, lowValueRow, handoffWithBlogMention, pollutedBlogRow, hubAlarmRow, neutralRow]);
  assert.equal(wikiSet.entries.length, 2, 'only high-value raw sources should enter wiki lane');
  assert.equal(wikiSet.entries[0].vaultEntryId, 'hv-1');
  assert.equal(wikiSet.entries.find((entry) => entry.vaultEntryId === 'hf-1')?.source, 'vault-entry:hf-1');
  assert.equal(wikiSet.skipped.find((item) => item.vaultEntryId === 'lv-1')?.lane, 'dreaming_digest');
  assert.equal(wikiSet.skipped.find((item) => item.vaultEntryId === 'blo-1')?.lane, 'dreaming_digest');
  assert.equal(wikiSet.skipped.find((item) => item.vaultEntryId === 'ha-1')?.reason, 'excluded_low_value_source');
  assert.equal(classifyVaultWikiSource(lowValueRow).reason, 'low_value_blog_comment');

  let llmCalls = 0;
  const llmReport = await buildLlmWikiCompileReport({
    outDir: path.join(tmp, 'wiki-llm'),
    limit: 10,
    dryRun: true,
    state: { version: 1, processedVaultEntryIds: [], updatedAt: null },
    queryReadonly: async (_schema, sql, params) => {
      if (/information_schema\.columns/i.test(sql)) {
        return [
          { column_name: 'abstraction_level' },
          { column_name: 'time_stage' },
          { column_name: 'validation_state' },
          { column_name: 'prediction_state' },
          { column_name: 'prediction_horizon' },
        ];
      }
      const patterns = params?.[0] || [];
      if (patterns.some((pattern) => String(pattern).includes('luna_review'))) return [highValueRow, handoffWithBlogMention, pollutedBlogRow, hubAlarmRow];
      if (patterns.some((pattern) => String(pattern).includes('blog_comment'))) return [lowValueRow];
      return [];
    },
    llmPreview: true,
    llmClient: async (request) => {
      llmCalls += 1;
      assert.equal(request.cycleId, request.cycle_id);
      assert.ok(request.cycleId, 'LLM preview must include cycle_id');
      assert.equal(request.policyOverride.chain[0].provider, 'openai-oauth');
      assert.match(request.policyOverride.chain[0].model, /mini/);
      return {
        ok: true,
        text: JSON.stringify({
          summary: 'Luna risk review links gate evidence to capital policy.',
          concepts: ['risk gate', 'capital policy'],
          qualityGate: 'pass',
          notes: ['fixture'],
        }),
        provider: 'mock',
        model: 'gpt-5.4-mini',
      };
    },
    now: new Date('2026-07-03T00:00:00.000Z'),
  });
  assert.equal(llmCalls, 1, 'dry-run preview should call LLM once');
  assert.equal(llmReport.llm.calls, 1);
  assert.equal(llmReport.counts.dreamingDigestCandidates, 2);
  assert.match(Object.values(llmReport.pages).join('\n'), /LLM Concept Preview/);
  assert.equal(fs.existsSync(path.join(tmp, 'wiki-llm/luna.md')), false, 'LLM dry-run must not write files');

  console.log(JSON.stringify({ ok: true, checks: 30 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
