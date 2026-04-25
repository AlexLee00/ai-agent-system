const BLOCKED_SUBAGENT_TOOLS = new Set([
  'send_telegram',
  'approval',
  'memory_write',
  'delegate_task',
]);

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getBlockedSubagentTools() {
  return [...BLOCKED_SUBAGENT_TOOLS];
}

function validateSubagentSandbox(input) {
  const contextSummary = normalizeText(input.contextSummary);
  const allowedTools = Array.isArray(input.allowedTools)
    ? input.allowedTools.map((tool) => normalizeText(tool)).filter(Boolean)
    : [];
  const parentTools = Array.isArray(input.parentTools)
    ? input.parentTools.map((tool) => normalizeText(tool)).filter(Boolean)
    : [];
  const maxConcurrency = Math.max(1, Number(input.maxConcurrency || 1) || 1);
  const maxDepth = Math.max(1, Number(input.maxDepth || 1) || 1);
  const finalSummaryOnly = input.finalSummaryOnly !== false;
  const freshContext = input.freshContext !== false;

  if (!contextSummary) {
    return { ok: false, error: 'subagent_context_required' };
  }
  if (!freshContext) {
    return { ok: false, error: 'subagent_requires_fresh_context' };
  }
  if (!finalSummaryOnly) {
    return { ok: false, error: 'subagent_requires_final_summary_only' };
  }
  if (maxConcurrency > 4) {
    return { ok: false, error: 'subagent_max_concurrency_exceeded' };
  }
  if (maxDepth > 4) {
    return { ok: false, error: 'subagent_max_depth_exceeded' };
  }
  for (const tool of allowedTools) {
    if (BLOCKED_SUBAGENT_TOOLS.has(tool)) {
      return { ok: false, error: `subagent_blocked_tool:${tool}` };
    }
  }
  if (parentTools.length > 0) {
    const parent = new Set(parentTools);
    for (const tool of allowedTools) {
      if (!parent.has(tool)) {
        return { ok: false, error: `subagent_tool_not_subset:${tool}` };
      }
    }
  }

  return {
    ok: true,
    policy: {
      freshContext: true,
      finalSummaryOnly: true,
      maxConcurrency,
      maxDepth,
      allowedTools,
      blockedTools: [...BLOCKED_SUBAGENT_TOOLS],
    },
  };
}

module.exports = {
  getBlockedSubagentTools,
  validateSubagentSandbox,
};
