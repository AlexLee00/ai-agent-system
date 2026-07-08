'use strict';

const pipeline = require('../auto-dev-pipeline');

/**
 * @param {{ id?: unknown }} [task]
 * @param {{ runtimeConfig?: unknown, allowClaudeCodeEmergency?: boolean }} [options]
 */
function buildSymphonyRunnerPlan(task = {}, options = {}) {
  const runtimeConfig = options && typeof options === 'object' && 'runtimeConfig' in options
    ? options.runtimeConfig
    : null;
  const allowClaudeCodeEmergency = options && typeof options === 'object' && 'allowClaudeCodeEmergency' in options
    ? Boolean(options.allowClaudeCodeEmergency)
    : false;
  const normalizedTask = task || {};
  const runtime = runtimeConfig || pipeline.resolveAutoDevRuntimeConfig({ dryRun: true });
  const modelMeta = pipeline._testOnly_buildImplementationModelMeta(runtime);
  const usesClaudeCode = modelMeta.provider === 'claude-code' || modelMeta.runner === 'claude';
  const blocked = usesClaudeCode && !runtime.compatibilityMode && !allowClaudeCodeEmergency;

  return {
    mode: 'plan_only',
    taskId: normalizedTask && typeof normalizedTask === 'object' && 'id' in normalizedTask ? normalizedTask.id || null : null,
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
