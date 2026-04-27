const {
  parseControlPlan,
  validateMutatingPlanPlaybook,
} = require('./plan-schema');
const { buildPlaybookTemplate } = require('./playbook');
const { hasHubControlTool } = require('./tool-registry');

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function inferTeam(inputTeam, message) {
  const direct = normalizeText(inputTeam).toLowerCase();
  if (direct) return direct;
  const lower = message.toLowerCase();
  if (lower.includes('루나') || lower.includes('luna') || lower.includes('investment')) return 'luna';
  if (lower.includes('블로그') || lower.includes('blog') || lower.includes('instagram')) return 'blog';
  if (lower.includes('클로드') || lower.includes('claude')) return 'claude';
  return 'general';
}

function inferMutatingIntent(message) {
  const lower = message.toLowerCase();
  return [
    '재시작',
    'restart',
    '적용',
    '실행',
    '수정',
    'fix',
    '조치',
    '매수',
    '매도',
  ].some((keyword) => lower.includes(keyword));
}

function buildHeuristicPlan(input) {
  const mutatingIntent = inferMutatingIntent(input.message);
  const playbook = buildPlaybookTemplate({ goal: input.goal, team: input.team });
  const steps = [
    {
      id: 'frame_health',
      tool: 'hub.health.query',
      args: { team: input.team, minutes: 60 },
      sideEffect: 'read_only',
      notes: '현재 이벤트/헬스 상태 확인',
    },
    {
      id: 'inspect_launchd',
      tool: 'launchd.status',
      args: { labels: ['ai.hub.resource-api', 'ai.claude.auto-dev.autonomous'] },
      sideEffect: 'read_only',
      notes: '핵심 launchd 상태 점검',
    },
    {
      id: 'inspect_repo',
      tool: 'repo.git_status',
      args: {},
      sideEffect: 'read_only',
      notes: '작업트리 상태 점검',
    },
  ];

  if (mutatingIntent) {
    steps.push({
      id: 'proposed_mutation',
      tool: 'repo.command.run',
      args: { cmd: 'echo planned_action_only' },
      sideEffect: 'external_mutation',
      notes: 'MVP에서는 실행 비활성, 승인/검토 대상으로만 유지',
    });
  }

  return {
    goal: input.goal,
    team: input.team,
    risk: mutatingIntent ? 'high' : 'low',
    requiresApproval: mutatingIntent,
    dryRun: input.dryRun !== false,
    steps,
    verify: [
      {
        tool: 'hub.health.query',
        args: { team: input.team, minutes: 30 },
      },
    ],
    playbook: {
      phases: playbook.phases,
    },
    metadata: {
      planner: 'heuristic',
      sourceMessage: input.message,
    },
  };
}

function extractJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const fragment = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(fragment);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function getCallWithFallback() {
  // Lazy-load the Hub-local LLM runtime to keep heuristic tests isolated.
  const hubLlm = require('../llm/unified-caller');
  if (typeof hubLlm?.callWithFallback !== 'function') {
    throw new Error('hub_llm_unavailable');
  }
  return hubLlm.callWithFallback;
}

async function tryLlmPlan(input) {
  const callWithFallback = getCallWithFallback();
  const plannerPrompt = [
    'You are Team Jay control planner.',
    'Return ONLY JSON object that matches this shape:',
    '{ "goal": string, "team": string, "risk": "low|medium|high|critical", "requiresApproval": boolean, "dryRun": boolean, "steps": [{ "id": string, "tool": string, "args": object, "sideEffect": "none|read_only|write|external_mutation|money_movement", "notes": string }], "verify": [{ "tool": string, "args": object }], "playbook": { "phases": [{ "phase": "frame|plan|review|test|ship|reflect", "objective": string, "checks": string[] }] }, "metadata": object }',
    'Unknown tool names are forbidden.',
    `Goal: ${input.goal}`,
    `Team: ${input.team}`,
    `User message: ${input.message}`,
    `Dry-run required: ${input.dryRun !== false}`,
  ].join('\n');

  const llmResult = await callWithFallback({
    chain: [
      { provider: 'openai-oauth', model: 'gpt-4.1-mini', maxTokens: 1200, temperature: 0.1, timeoutMs: 8000 },
      { provider: 'claude-code', model: 'sonnet', maxTokens: 1200, temperature: 0.1, timeoutMs: 10000 },
    ],
    selectorKey: 'hub.control.planner',
    callerTeam: 'hub',
    agent: 'control-planner',
    taskType: 'control_plan_draft',
    systemPrompt: 'You are strict JSON planner. No prose.',
    prompt: plannerPrompt,
    timeoutMs: 12_000,
  });

  const json = extractJsonObject(llmResult?.result || llmResult?.text || '');
  if (!json) {
    throw new Error('llm_plan_json_parse_failed');
  }

  return {
    ...json,
    team: normalizeText(json.team, input.team),
    goal: normalizeText(json.goal, input.goal),
    dryRun: input.dryRun !== false,
    metadata: {
      ...(json.metadata || {}),
      planner: 'llm',
      provider: llmResult?.provider || 'unknown',
      model: llmResult?.model || 'unknown',
    },
  };
}

function validateToolReferences(plan) {
  const unknown = (plan.steps || [])
    .map((step) => normalizeText(step.tool))
    .filter((tool) => tool && !hasHubControlTool(tool));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown_tools:${[...new Set(unknown)].join(',')}`,
    };
  }
  return { ok: true };
}

async function generateControlPlanDraft(input) {
  const message = normalizeText(input.message || input.goal);
  const goal = normalizeText(input.goal, message);
  const team = inferTeam(input.team, message);
  const dryRun = input.dryRun !== false;

  const llmEnabled = String(process.env.HUB_CONTROL_PLANNER_DISABLE_LLM || '').trim() !== '1'
    && String(process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC || '').trim() !== '1';

  let candidate;
  let plannerSource = 'heuristic';
  let plannerWarnings = [];

  if (llmEnabled) {
    try {
      candidate = await tryLlmPlan({ goal, message, team, dryRun });
      plannerSource = 'llm';
    } catch (error) {
      plannerWarnings.push(`llm_fallback:${error?.message || error}`);
    }
  }

  if (!candidate) {
    candidate = buildHeuristicPlan({ goal, message, team, dryRun });
  }

  const parsed = parseControlPlan(candidate);
  if (!parsed.ok) {
    if (plannerSource === 'llm') {
      plannerWarnings.push('llm_plan_schema_invalid_fallback_heuristic');
      const fallback = buildHeuristicPlan({ goal, message, team, dryRun });
      const fallbackParsed = parseControlPlan(fallback);
      if (!fallbackParsed.ok) {
        return { ok: false, error: fallbackParsed.error };
      }
      const toolValidation = validateToolReferences(fallbackParsed.data);
      if (!toolValidation.ok) return { ok: false, error: toolValidation.error };
      const playbookValidation = validateMutatingPlanPlaybook(fallbackParsed.data);
      if (!playbookValidation.ok) return { ok: false, error: playbookValidation.error };
      return {
        ok: true,
        plan: fallbackParsed.data,
        planner_source: 'heuristic',
        warnings: plannerWarnings,
      };
    }
    return { ok: false, error: parsed.error };
  }

  const toolValidation = validateToolReferences(parsed.data);
  if (!toolValidation.ok) return { ok: false, error: toolValidation.error };

  const playbookValidation = validateMutatingPlanPlaybook(parsed.data);
  if (!playbookValidation.ok) return { ok: false, error: playbookValidation.error };

  return {
    ok: true,
    plan: parsed.data,
    planner_source: plannerSource,
    warnings: plannerWarnings,
  };
}

module.exports = {
  generateControlPlanDraft,
};
