// @ts-nocheck
'use strict';

const pipeline = require('../auto-dev-pipeline');

function buildSymphonyRunnerPlan(task = {}, {
  runtimeConfig = null,
  allowClaudeCodeEmergency = false,
} = {}) {
  const runtime = runtimeConfig || pipeline.resolveAutoDevRuntimeConfig({ dryRun: true });
  const modelMeta = pipeline._testOnly_buildImplementationModelMeta(runtime);
  const usesClaudeCode = modelMeta.provider === 'claude-code' || modelMeta.runner === 'claude';
  const blocked = usesClaudeCode && !runtime.compatibilityMode && !allowClaudeCodeEmergency;

  return {
    mode: 'plan_only',
    taskId: task.id || null,
    provider: modelMeta.provider,
    model: modelMeta.model,
    cliModelArg: modelMeta.cliModelArg,
    runner: modelMeta.runner,
    source: modelMeta.source,
    commandFamily: modelMeta.runner === 'codex' ? 'codex_exec' : 'claude_print',
    blocked,
    blockReason: blocked ? 'claude_code_runner_requires_compat_or_emergency' : null,
    preferred: modelMeta.provider === 'openai-oauth' && modelMeta.runner === 'codex',
  };
}

module.exports = {
  buildSymphonyRunnerPlan,
};
