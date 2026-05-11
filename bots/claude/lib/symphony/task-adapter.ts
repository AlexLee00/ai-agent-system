// @ts-nocheck
'use strict';

const crypto = require('crypto');
const path = require('path');
const pipeline = require('../auto-dev-pipeline');

const SYMPHONY_TASK_SCHEMA_VERSION = 1;

function hashTaskIdentity(relPath, contentHash) {
  return crypto.createHash('sha1').update(`${relPath}:${contentHash}`).digest('hex').slice(0, 16);
}

function toArray(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function classifyPolicy(policy = {}) {
  if (policy.decision === 'allow') return 'ready';
  if (policy.status === 'completed' || policy.decision === 'implementation_completed') return 'completed';
  return 'blocked';
}

function buildSymphonyTaskFromDocument(filePath, {
  content = null,
  runtimeConfig = null,
  source = 'docs_auto_dev',
} = {}) {
  const analysis = pipeline.analyzeAutoDevDocument(filePath, content);
  const policy = pipeline._testOnly_evaluateDocumentPolicy(analysis);
  const runtime = runtimeConfig || pipeline.resolveAutoDevRuntimeConfig({ dryRun: true });
  const modelMeta = pipeline._testOnly_buildImplementationModelMeta(runtime);
  const taskId = hashTaskIdentity(analysis.relPath, analysis.contentHash);
  const metadata = analysis.metadata || {};

  return {
    schemaVersion: SYMPHONY_TASK_SCHEMA_VERSION,
    id: taskId,
    source,
    sourcePath: analysis.relPath,
    title: analysis.title,
    status: classifyPolicy(policy),
    contentHash: analysis.contentHash,
    createdFrom: {
      type: 'auto_dev_document',
      fileName: path.basename(filePath),
      lineCount: analysis.lineCount,
      hasFrontmatter: analysis.hasFrontmatter === true,
    },
    metadata: {
      targetTeam: metadata.target_team || policy.targetTeam || null,
      ownerAgent: metadata.owner_agent || null,
      riskTier: metadata.risk_tier || policy.riskTier || null,
      taskType: metadata.task_type || null,
      autonomyLevel: metadata.autonomy_level || null,
      requiresLiveExecution: metadata.requires_live_execution === true,
    },
    scope: {
      write: toArray(metadata.write_scope || policy.writeScope),
      test: toArray(metadata.test_scope),
      relatedFiles: toArray(analysis.relatedFiles).slice(0, 20),
      codeRefs: toArray(analysis.codeRefs).slice(0, 20),
    },
    policy: {
      decision: policy.decision || null,
      policyDecision: policy.policyDecision || null,
      reason: policy.reason || null,
    },
    runner: {
      provider: modelMeta.provider,
      model: modelMeta.model,
      cliModelArg: modelMeta.cliModelArg,
      runner: modelMeta.runner,
      source: modelMeta.source,
    },
    validators: [
      { id: 'reviewer', required: true, outputSchema: 'auto_dev_review_result_v1' },
      { id: 'guardian', required: true, outputSchema: 'auto_dev_guardian_result_v1' },
      { id: 'builder', required: true, outputSchema: 'auto_dev_build_result_v1' },
      { id: 'test_runner', required: true, outputSchema: 'auto_dev_test_result_v1' },
    ],
    summary: analysis.summary,
    searchTerms: toArray(analysis.searchTerms).slice(0, 8),
  };
}

function compareTaskWithLegacy(task = {}) {
  return {
    ok: true,
    comparedAt: new Date().toISOString(),
    checks: {
      targetTeamPreserved: Boolean(task.metadata?.targetTeam),
      writeScopePreserved: (task.scope?.write || []).length > 0,
      testScopePreserved: (task.scope?.test || []).length > 0,
      riskTierPreserved: Boolean(task.metadata?.riskTier),
      runnerPlanned: Boolean(task.runner?.provider && task.runner?.model),
      validatorsPlanned: (task.validators || []).length >= 4,
    },
  };
}

module.exports = {
  SYMPHONY_TASK_SCHEMA_VERSION,
  buildSymphonyTaskFromDocument,
  compareTaskWithLegacy,
  hashTaskIdentity,
};
