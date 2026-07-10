#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  VAULT_TIERS,
  buildVaultTierReport,
  isVaultTierReportEnabled,
  knowledgeHygieneCheck,
  resolveVaultTier,
} from '../vault/vault-tiering.ts';
import { buildLibrarianReport } from './runtime-sigma-librarian.ts';

function entry(overrides = {}) {
  return {
    id: overrides.id || 'id-1',
    title: overrides.title || 'sample',
    type: overrides.type || 'library_record',
    source: overrides.source || 'luna_signal',
    file_path: overrides.file_path || 'library/sample',
    meta: overrides.meta || { sourceKind: overrides.type || 'library_record' },
  };
}

function testResolveVaultTier() {
  assert.equal(resolveVaultTier(entry({ type: 'blog_post', source: 'blo' })).tier, VAULT_TIERS.RAW_CORPUS);
  assert.equal(resolveVaultTier(entry({ type: 'blog_comment', source: 'blo' })).tier, VAULT_TIERS.RAW_CORPUS);
  assert.equal(resolveVaultTier(entry({ type: 'blog_external_trend', source: 'blo' })).tier, VAULT_TIERS.RAW_CORPUS);
  assert.equal(resolveVaultTier(entry({ type: 'library_record', source: 'luna_signal' })).tier, VAULT_TIERS.KNOWLEDGE);
  assert.equal(resolveVaultTier(entry({ type: 'auto_dev_outcome', source: 'claude_auto_dev' })).tier, VAULT_TIERS.KNOWLEDGE);
  assert.equal(resolveVaultTier(entry({ type: 'refactor_outcome', source: 'claude_refactor' })).tier, VAULT_TIERS.KNOWLEDGE);
  assert.equal(resolveVaultTier(entry({ type: 'mystery', source: 'unknown' })).tier, VAULT_TIERS.UNKNOWN);
}

function testKnowledgeHygiene() {
  const blogRaw = entry({
    type: 'blog_post',
    source: 'blo',
    meta: { sourceKind: 'blog_post', sourceTable: 'blog.posts' },
  });
  const rawPromotionCheck = knowledgeHygieneCheck(blogRaw, { targetTier: VAULT_TIERS.KNOWLEDGE });
  assert.equal(rawPromotionCheck.allowed, false);
  assert.ok(rawPromotionCheck.reasons.includes('requeryable_raw_source'));

  const lesson = entry({
    type: 'library_record',
    source: 'luna_signal',
    meta: { sourceKind: 'library_record', lesson: 'surprising edge found' },
  });
  assert.equal(knowledgeHygieneCheck(lesson).allowed, true);

  const weakKnowledge = entry({ type: 'library_record', source: 'luna_signal', meta: { sourceKind: 'library_record' } });
  const weakCheck = knowledgeHygieneCheck(weakKnowledge);
  assert.equal(weakCheck.allowed, false);
  assert.ok(weakCheck.reasons.includes('missing_surprising_signal'));

  const unmapped = entry({ type: 'mystery', source: 'unknown', meta: { lesson: 'surprising edge found' } });
  const unmappedCheck = knowledgeHygieneCheck(unmapped, { targetTier: VAULT_TIERS.KNOWLEDGE });
  assert.equal(unmappedCheck.allowed, false);
  assert.ok(unmappedCheck.reasons.includes('unmapped_entry_type'));

  const rawTargetCheck = knowledgeHygieneCheck(unmapped, { targetTier: VAULT_TIERS.RAW_CORPUS });
  assert.equal(rawTargetCheck.allowed, true);
}

function testReportBuilder() {
  const report = buildVaultTierReport([
    entry({ id: 'raw-1', type: 'blog_post', source: 'blo', meta: { sourceKind: 'blog_post', sourceTable: 'blog.posts' } }),
    entry({ id: 'raw-2', type: 'blog_comment', source: 'blo', meta: { sourceKind: 'blog_comment', sourceTable: 'blog.comments' } }),
    entry({ id: 'knowledge-1', type: 'library_record', source: 'luna_signal', meta: { lesson: 'non-obvious', sourceKind: 'library_record' } }),
  ]);
  assert.equal(report.total, 3);
  assert.equal(report.tierCounts.raw_corpus, 2);
  assert.equal(report.tierCounts.knowledge, 1);
  assert.equal(report.rawPromotionBlockedSamples.length, 2);
}

async function testLibrarianReportGate() {
  const queryReadonly = async (schema, sql) => {
    if (/FROM sigma\.vault_entries v/.test(sql)) return [];
    if (/FROM sigma\.vault_entries/.test(sql)) {
      return [
        entry({ id: 'raw-1', type: 'blog_post', source: 'blo', meta: { sourceKind: 'blog_post', sourceTable: 'blog.posts' } }),
        entry({ id: 'knowledge-1', type: 'library_record', source: 'luna_signal', meta: { lesson: 'surprising', sourceKind: 'library_record' } }),
      ];
    }
    return [];
  };
  assert.equal(isVaultTierReportEnabled({}), false);
  const disabled = await buildLibrarianReport({ queryReadonly, env: {} });
  assert.equal(disabled.vaultTierReport, null);

  const enabled = await buildLibrarianReport({
    queryReadonly,
    env: { SIGMA_VAULT_TIER_REPORT_ENABLED: 'true' },
  });
  assert.equal(enabled.vaultTierReport.total, 2);
  assert.equal(enabled.vaultTierReport.tierCounts.raw_corpus, 1);
  assert.equal(enabled.liveMutation, false);
}

async function main() {
  testResolveVaultTier();
  testKnowledgeHygiene();
  testReportBuilder();
  await testLibrarianReportGate();
  console.log(JSON.stringify({
    ok: true,
    smoke: 'sigma-vault-tiering',
    checks: 4,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, smoke: 'sigma-vault-tiering', error: error?.message || String(error) }, null, 2));
  process.exit(1);
});
