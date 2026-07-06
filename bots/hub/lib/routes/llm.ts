const pgPool = require('../../../../packages/core/lib/pg-pool');
const crypto = require('node:crypto');
const { callClaudeCodeOAuth } = require('../llm/claude-code-oauth');
const { callGeminiCliOAuth, callGeminiCodeAssistOAuth, callOpenAiCodexOAuth } = require('../llm/oauth-direct');
const { callGroqFallback } = require('../llm/groq-fallback');
const { callWithFallback } = require('../llm/unified-caller');
const { routeModel, updateRoutingResult } = require('../llm/llm-auto-router');
const { loadGroqAccounts } = require('../llm/secrets-loader');
const rag = require('../../../../packages/core/lib/rag');
const { getLlmAdmissionState } = require('../llm/admission-control');
const {
  createLlmJob,
  readJob,
  listLlmJobs,
  getJobStoreState,
} = require('../llm/job-store');
const { parseLlmCallPayload } = require('../llm/request-schema');
const hubLlmSelector = require('../../src/llm-selector');
const { isHubLlmRouteTargetAllowed, resolveHubLlmSelection, isGeminiDisabled } = hubLlmSelector;
const selectorTimeoutProfiles = require('../../../../packages/core/lib/selector-timeout-profiles');
const { getAllCircuitStatuses, resetCircuit, resetAllCircuits } = require('../../../../packages/core/lib/local-circuit-breaker');
const {
  getProviderCooldownSnapshot,
  resetProviderCooldown,
} = require('../../../../packages/core/lib/llm-fallback');
const { getProviderStats, resetProviderCircuit, resetAllProviderCircuits } = require('../llm/provider-registry');
const { recordHubTelemetry } = require('../telemetry');

type AnyRecord = Record<string, any>;
type RouteReq = AnyRecord;
type RouteRes = AnyRecord;

let routingLogAuditColumnsPromise: Promise<boolean> | null = null;
let routingLogTraceColumnsPromise: Promise<boolean> | null = null;
let routingLogTraceColumnsCheckedAt = 0;
let routingLogStandardColumnsPromise: Promise<boolean> | null = null;
let routingLogStandardColumnsCheckedAt = 0;

// POST /hub/llm/call — Primary(Claude Code OAuth) + Fallback(Groq) 체인
export async function llmCallRoute(req: RouteReq, res: RouteRes) {
  const context = req.hubRequestContext || {};
  const parsed = parseLlmCallPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: parsed.error,
      traceId: context.traceId || null,
    });
  }
  const body = parsed.data;
  const normalizedRequest = normalizeLlmCallRequest(body, context);
  if (!checkLlmRouteTarget(res, context, normalizedRequest)) return;
  recordHubTelemetry('llm_call_start', {
    traceId: context.traceId || normalizedRequest.traceId || null,
    callerTeam: normalizedRequest.callerTeam || null,
    agent: normalizedRequest.agent || null,
    selectorKey: normalizedRequest.selectorKey || null,
    runtimePurpose: normalizedRequest.runtimePurpose || normalizedRequest.taskType || null,
  });
  const autoRouting = applyAutoRoutingShadowWiring(normalizedRequest);
  const llmRequest = autoRouting.request;

  try {
    const resp = await callWithFallback(llmRequest);
    recordHubTelemetry('llm_call_end', {
      traceId: context.traceId || llmRequest.traceId || null,
      callerTeam: llmRequest.callerTeam || null,
      agent: llmRequest.agent || null,
      ok: resp.ok === true,
      provider: resp.provider || null,
      selectedRoute: resp.selected_route || null,
      fallbackCount: resp.fallbackCount || 0,
      fallbackUsed: Boolean(resp.fallbackUsed ?? Number(resp.fallbackCount || 0) > 0),
      durationMs: resp.durationMs || 0,
    });

    logRouting(resp, llmRequest).catch((err: any) =>
      console.error('[llm] routing log 기록 실패:', err.message)
    );
    recordAutoRoutingResult(autoRouting, resp).catch((err: any) =>
      console.error('[llm] auto-routing result update 실패:', err.message)
    );

    const providerBackpressure = buildProviderBackpressure(resp);
    if (providerBackpressure?.retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(providerBackpressure.retryAfterMs / 1000))));
    }

    return res.json({
      ...resp,
      traceId: context.traceId || null,
      admission: {
        queued: Boolean(res.locals?.llmAdmissionQueued),
      },
      ...(providerBackpressure ? { providerBackpressure } : {}),
    });
  } catch (err: any) {
    const providerBackpressure = buildProviderBackpressure({ error: err.message });
    if (providerBackpressure?.retryAfterMs) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(providerBackpressure.retryAfterMs / 1000))));
    }
    const failureResp = {
      ok: false,
      provider: 'failed',
      durationMs: 0,
      error: err.message,
      traceId: context.traceId || null,
      ...(providerBackpressure ? { providerBackpressure } : {}),
    };
    recordHubTelemetry('llm_call_error', {
      traceId: context.traceId || llmRequest.traceId || null,
      callerTeam: llmRequest.callerTeam || null,
      agent: llmRequest.agent || null,
      error: err.message,
    });
    recordAutoRoutingResult(autoRouting, failureResp).catch((updateErr: any) =>
      console.error('[llm] auto-routing failure update 실패:', updateErr.message)
    );
    return res.status(500).json(failureResp);
  }
}

// POST /hub/llm/vision — Hub-owned multimodal analysis gateway.
export async function llmVisionRoute(req: RouteReq, res: RouteRes) {
  const context = req.hubRequestContext || {};
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  const callerTeam = String(body.callerTeam || context.callerTeam || '').trim();
  const agent = String(body.agent || context.agent || '').trim();
  const selectorKey = String(body.selectorKey || '').trim() || undefined;
  const taskType = String(body.taskType || 'vision').trim();
  const image = normalizeVisionImage(body);

  if (!prompt) return res.status(400).json({ ok: false, error: 'prompt_required', traceId: context.traceId || null });
  if (!callerTeam) return res.status(400).json({ ok: false, error: 'callerTeam_required', traceId: context.traceId || null });
  if (!agent) return res.status(400).json({ ok: false, error: 'agent_required', traceId: context.traceId || null });
  if (!image.ok) return res.status(image.status || 400).json({ ok: false, error: image.error, traceId: context.traceId || null });

  const normalizedRequest = {
    callerTeam,
    agent,
    selectorKey,
    taskType,
    prompt,
    requestId: body.requestId || body.traceId || body.trace_id || context.traceId || undefined,
    traceId: body.traceId || body.trace_id || context.traceId || undefined,
    trace_id: body.trace_id || body.traceId || context.traceId || undefined,
    cycleId: body.cycleId || body.cycle_id || undefined,
    cycle_id: body.cycle_id || body.cycleId || undefined,
  };
  if (!checkLlmRouteTarget(res, context, normalizedRequest)) return;

  const timeoutMs = Math.max(5_000, Math.min(180_000, Number(body.timeoutMs || 45_000) || 45_000));
  const maxTokens = Number(body.maxTokens || 512) || 512;
  const temperature = body.temperature ?? 0.1;
  const budget = checkVisionBudget(callerTeam, estimateVisionCostUsd(body, image, maxTokens));
  if (!budget.ok) {
    return res.status(429).json({
      ok: false,
      provider: 'failed',
      error: `budget_exceeded: ${budget.reason}`,
      estimatedCostUsd: budget.estimatedCostUsd,
      budgetGuardStatus: 'blocked',
      traceId: context.traceId || null,
    });
  }

  const selection = resolveVisionSelection({
    ...normalizedRequest,
    maxTokens,
    temperature,
    timeoutMs,
    maxBudgetUsd: body.maxBudgetUsd,
  });
  if (!selection.ok) {
    return res.status(selection.status || 409).json({
      ok: false,
      provider: 'failed',
      error: selection.error,
      selectorKey: selection.selectorKey || null,
      providerTiers: selection.providerTiers || [],
      traceId: context.traceId || null,
    });
  }

  const started = Date.now();
  const input = {
    prompt,
    systemPrompt: body.systemPrompt || '',
    maxTokens,
    temperature,
    timeoutMs,
    images: [{ mimeType: image.mimeType, dataBase64: image.dataBase64 }],
  };

  const attempts: AnyRecord[] = [];
  let resp: AnyRecord | null = null;
  let selectedRoute: string | null = null;
  for (const route of selection.routes) {
    const attempt = await callVisionSelectorRoute(route, {
      ...input,
      imageDetail: body.imageDetail || 'low',
    });
    if (attempt.ok) {
      resp = attempt;
      selectedRoute = route.route;
      break;
    }
    attempts.push({ provider: route.route, error: attempt.error || 'unknown', durationMs: attempt.durationMs || 0 });
  }

  if (!resp) {
    resp = {
      ok: false,
      provider: 'failed',
      model: null,
      durationMs: Date.now() - started,
      error: `fallback_exhausted: ${(attempts[attempts.length - 1] || {}).error || 'no_vision_route'}`,
    };
  }

  const logBody = {
    ...normalizedRequest,
    abstractModel: 'vision',
    systemPrompt: body.systemPrompt || '',
    prompt: `${prompt}\n[image:${image.mimeType};sha256=${image.sha256};bytes=${image.bytes}]`,
  };
  logRouting({
    ...resp,
    durationMs: resp.durationMs || (Date.now() - started),
    totalCostUsd: 0,
    selected_route: selectedRoute,
    selectorKey: selection.selectorKey,
    runtimeProfile: selection.runtimeProfile || null,
    runtimePurpose: selection.runtimePurpose || null,
    routeTargetKind: selection.routeTargetKind || null,
    providerTiers: selection.providerTiers || [],
    estimatedCostUsd: budget.estimatedCostUsd,
    budgetGuardStatus: budget.status,
    attempted_providers: attempts.map((attempt) => attempt.provider),
    fallbackCount: attempts.length,
  }, logBody).catch((err: any) => console.error('[llm] vision routing log 기록 실패:', err.message));

  if (!resp.ok) {
    return res.status(500).json({
      ok: false,
      provider: resp.provider || 'failed',
      error: resp.error || 'vision_call_failed',
      primaryError: resp.primaryError || null,
      durationMs: resp.durationMs || (Date.now() - started),
      traceId: context.traceId || null,
    });
  }

  return res.json({
    ok: true,
    text: resp.text || resp.result || '',
    result: resp.result || resp.text || '',
    provider: resp.provider,
    model: resp.model,
    selected_route: selectedRoute,
    selectorKey: selection.selectorKey,
    providerTiers: selection.providerTiers || [],
    fallbackCount: attempts.length,
    attempted_providers: attempts.map((attempt) => attempt.provider),
    durationMs: resp.durationMs || (Date.now() - started),
    admission: {
      queued: Boolean(res.locals?.llmAdmissionQueued),
    },
    traceId: context.traceId || null,
  });
}

// POST /hub/llm/embeddings — Hub-owned embedding gateway.
export async function llmEmbeddingsRoute(req: RouteReq, res: RouteRes) {
  const context = req.hubRequestContext || {};
  const body = req.body || {};
  const input = body.input ?? body.text ?? body.prompt;
  const callerTeam = String(body.callerTeam || context.callerTeam || '').trim();
  const agent = String(body.agent || context.agent || '').trim();
  const selectorKey = String(body.selectorKey || '').trim() || undefined;
  const taskType = String(body.taskType || 'embedding').trim();
  const texts = Array.isArray(input) ? input.map((item) => String(item || '')) : [String(input || '')];
  const nonEmptyTexts = texts.map((item) => item.trim()).filter(Boolean);

  if (!nonEmptyTexts.length) return res.status(400).json({ ok: false, error: 'input_required', traceId: context.traceId || null });
  if (!callerTeam) return res.status(400).json({ ok: false, error: 'callerTeam_required', traceId: context.traceId || null });
  if (!agent) return res.status(400).json({ ok: false, error: 'agent_required', traceId: context.traceId || null });

  const normalizedRequest = {
    callerTeam,
    agent,
    selectorKey,
    taskType,
    prompt: nonEmptyTexts.join('\n\n').slice(0, 8000),
    requestId: body.requestId || body.traceId || body.trace_id || context.traceId || undefined,
    traceId: body.traceId || body.trace_id || context.traceId || undefined,
    trace_id: body.trace_id || body.traceId || context.traceId || undefined,
    cycleId: body.cycleId || body.cycle_id || undefined,
    cycle_id: body.cycle_id || body.cycleId || undefined,
  };
  if (!checkLlmRouteTarget(res, context, normalizedRequest)) return;

  const started = Date.now();
  try {
    const embeddings = await rag.createEmbeddingBatch(nonEmptyTexts);
    const dimensions = embeddings[0]?.length || 0;
    const expectedDimensions = Number(body.expectedDimensions || 0) || null;
    if (expectedDimensions && dimensions !== expectedDimensions) {
      return res.status(409).json({
        ok: false,
        error: 'embedding_dimension_mismatch',
        dimensions,
        expectedDimensions,
        model: rag.EMBED_MODEL,
        traceId: context.traceId || null,
      });
    }

    logRouting({
      ok: true,
      provider: 'local-embedding',
      model: rag.EMBED_MODEL,
      durationMs: Date.now() - started,
      totalCostUsd: 0,
      fallbackCount: 0,
      selected_route: `local/${rag.EMBED_MODEL}`,
    }, {
      ...normalizedRequest,
      abstractModel: 'embedding',
      prompt: `[embedding:${nonEmptyTexts.length};sha256=${hashText(nonEmptyTexts.join('\n'))}]`,
    }).catch((err) => console.error('[llm] embedding routing log 기록 실패:', err.message));

    return res.json({
      ok: true,
      model: rag.EMBED_MODEL,
      dimensions,
      data: embeddings.map((embedding: unknown, index: number) => ({ index, embedding })),
      durationMs: Date.now() - started,
      traceId: context.traceId || null,
    });
  } catch (err: any) {
    logRouting({
      ok: false,
      provider: 'local-embedding',
      model: rag.EMBED_MODEL,
      durationMs: Date.now() - started,
      totalCostUsd: 0,
      fallbackCount: 0,
      error: err.message || String(err),
      selected_route: `local/${rag.EMBED_MODEL}`,
    }, {
      ...normalizedRequest,
      abstractModel: 'embedding',
      prompt: `[embedding_failed:${nonEmptyTexts.length}]`,
    }).catch(() => {});
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
      model: rag.EMBED_MODEL,
      durationMs: Date.now() - started,
      traceId: context.traceId || null,
    });
  }
}

// GET /hub/llm/gateway-contract — 외부 프로젝트용 LLM Gateway 계약
export async function llmGatewayContractRoute(req: RouteReq, res: RouteRes) {
  return res.json({
    ok: true,
    contractVersion: 'hub-llm-gateway/v1',
    status: 'active',
    auth: {
      scheme: 'bearer',
      header: 'Authorization: Bearer <HUB_AUTH_TOKEN>',
      providerSecretsDistributedToClients: false,
    },
    endpoints: {
      syncCall: {
        method: 'POST',
        path: '/hub/llm/call',
        useCase: 'short classification, summarization, extraction, JSON response',
      },
      asyncJob: {
        method: 'POST',
        path: '/hub/llm/jobs',
        resultPaths: ['/hub/llm/jobs/:id', '/hub/llm/jobs/:id/result'],
        useCase: 'long research, multi-document synthesis, high-latency work',
      },
      vision: {
        method: 'POST',
        path: '/hub/llm/vision',
        useCase: 'image/chart analysis without distributing provider secrets',
      },
      embeddings: {
        method: 'POST',
        path: '/hub/llm/embeddings',
        useCase: 'RAG embedding creation through Hub-owned local embedding infrastructure',
      },
      stats: {
        method: 'GET',
        path: '/hub/llm/stats?hours=24&team=<callerTeam>',
      },
    },
    headers: {
      team: 'X-Hub-Team',
      agent: 'X-Hub-Agent',
      priority: 'X-Hub-Priority',
      traceId: 'X-Hub-Trace-Id',
    },
    requiredBody: ['prompt', 'abstractModel'],
    recommendedBody: ['callerTeam', 'agent', 'selectorKey', 'taskType', 'requestId', 'maxBudgetUsd', 'timeoutMs'],
    selectorPolicy: {
      normalPath: 'callerTeam + agent or selectorKey',
      externalProjectDefault: 'Use selectorKey until the external project has approved registry entries.',
      adHocChain: 'blocked_by_default',
      directProviderRoutes: 'disabled_by_default',
      nonLlmTargets: 'blocked',
    },
    providerPolicy: {
      geminiDisabled: isGeminiDisabled(),
      geminiDisableFlag: 'HUB_LLM_GEMINI_DISABLED',
      geminiDisabledError: 'gemini_provider_disabled',
      directTokenRefreshChecks: isGeminiDisabled() ? 'skipped_for_gemini' : 'enabled',
    },
    observability: {
      requestLog: 'hub.llm_request_log',
      traceResponseHeader: 'X-Hub-Trace-Id',
      budgetFields: ['estimated_cost_usd', 'budget_guard_status', 'provider_tier'],
    },
    safety: {
      maxBudgetUsdRecommended: true,
      providerTokenHandling: 'Hub only',
      protectedServiceMutationByExternalProjects: false,
    },
    docs: {
      integrationGuide: 'docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md',
      stageCOperations: 'docs/hub/HUB_STAGE_C_OPERATIONS.md',
    },
  });
}

// POST /hub/llm/jobs — 비동기 LLM job 생성
export async function llmJobsCreateRoute(req: RouteReq, res: RouteRes) {
  const context = req.hubRequestContext || {};
  const parsed = parseLlmCallPayload(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      ok: false,
      error: parsed.error,
      traceId: context.traceId || null,
    });
  }
  const body = parsed.data;
  const normalizedRequest = normalizeLlmCallRequest(body, context);
  if (!checkLlmRouteTarget(res, context, normalizedRequest)) return;
  const job = await createLlmJob(normalizedRequest, context, { source: 'api' });
  return res.status(202).json({
    ok: true,
    jobId: job.id,
    status: job.status,
    traceId: context.traceId || null,
    statusUrl: `/hub/llm/jobs/${job.id}`,
    resultUrl: `/hub/llm/jobs/${job.id}/result`,
  });
}

function normalizeLlmCallRequest(
  body: Record<string, any>,
  context: { callerTeam?: string; agent?: string; priority?: string; traceId?: string | null },
) {
  return {
    ...body,
    callerTeam: body.callerTeam || context.callerTeam || undefined,
    agent: body.agent || context.agent || undefined,
    urgency: body.urgency || context.priority || undefined,
    requestId: body.requestId || body.traceId || body.trace_id || context.traceId || undefined,
    traceId: body.traceId || body.trace_id || context.traceId || undefined,
    trace_id: body.trace_id || body.traceId || context.traceId || undefined,
    cycleId: body.cycleId || body.cycle_id || undefined,
    cycle_id: body.cycle_id || body.cycleId || undefined,
  };
}

function checkLlmRouteTarget(
  res: RouteRes,
  context: { traceId?: string | null },
  normalizedRequest: Record<string, unknown>,
) {
  const targetPolicy = isHubLlmRouteTargetAllowed(normalizedRequest);
  if (!targetPolicy.ok) {
    res.status(403).json({
      ok: false,
      error: {
        code: targetPolicy.error,
        message: 'LLM route target is not active',
        target: targetPolicy.target,
      },
      traceId: context.traceId || null,
    });
    return null;
  }
  return targetPolicy;
}

export function resolveAutoRoutingMode(env: Record<string, any> = process.env): 'disabled' | 'shadow' | 'active' {
  const raw = String(env.LLM_AUTO_ROUTING_ENABLED || '').trim().toLowerCase();
  if (raw === 'shadow') return 'shadow';
  if (raw === 'true') return 'active';
  return 'disabled';
}

export function buildAutoRoutingInput(request: AnyRecord = {}): AnyRecord {
  return {
    prompt: String(request.prompt || ''),
    systemPrompt: String(request.systemPrompt || ''),
    abstractModel: request.abstractModel,
    taskType: request.taskType || request.task_type || request.runtimePurpose || request.runtime_purpose,
    agent: request.agent,
    callerTeam: request.callerTeam,
    cacheEnabled: request.cacheEnabled,
  };
}

export function applyAutoRoutingShadowWiring(
  normalizedRequest: AnyRecord,
  deps: { env?: Record<string, any>; routeModel?: (input: AnyRecord) => AnyRecord } = {},
): AnyRecord {
  const mode = resolveAutoRoutingMode(deps.env || process.env);
  if (mode === 'disabled') {
    return { mode, result: null, request: normalizedRequest, activeApplied: false };
  }
  const routeModelFn = deps.routeModel || routeModel;
  try {
    const result = routeModelFn(buildAutoRoutingInput(normalizedRequest));
    if (mode === 'active' && !normalizedRequest.abstractModel && result?.modelOverridden === true && result?.resolvedModel) {
      return {
        mode,
        result,
        request: { ...normalizedRequest, abstractModel: result.resolvedModel },
        activeApplied: true,
      };
    }
    return { mode, result, request: normalizedRequest, activeApplied: false };
  } catch (err: any) {
    return {
      mode,
      result: null,
      request: normalizedRequest,
      activeApplied: false,
      error: err?.message || String(err),
    };
  }
}

function optionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapAutoRoutingResultUpdate(autoRouting: AnyRecord, response: AnyRecord): AnyRecord | null {
  if (!autoRouting?.result?.autoModel) return null;
  const request = autoRouting.request || {};
  const provider = response?.selectedProvider
    || response?.provider
    || (typeof response?.selected_route === 'string' ? response.selected_route.split('/')[0] : null);
  const cost = optionalNumber(response?.totalCostUsd ?? response?.costUsd ?? response?.estimatedCostUsd);
  return {
    agent: request.agent,
    callerTeam: request.callerTeam,
    autoModel: autoRouting.result.autoModel,
    selectedProvider: provider || null,
    latencyMs: optionalNumber(response?.durationMs ?? response?.latencyMs),
    costUsd: cost,
    success: response?.ok === true,
    errorCode: response?.error ? String(response.error).slice(0, 240) : null,
  };
}

export async function recordAutoRoutingResult(
  autoRouting: AnyRecord,
  response: AnyRecord,
  deps: { updateRoutingResult?: (payload: AnyRecord) => Promise<void> } = {},
) {
  const payload = mapAutoRoutingResultUpdate(autoRouting, response);
  if (!payload) return { skipped: true };
  const updateFn = deps.updateRoutingResult || updateRoutingResult;
  await updateFn(payload);
  return { ok: true, payload };
}

function rejectIfDirectProviderRoutesDisabled(res: RouteRes): boolean {
  if (directProviderRoutesEnabled()) return false;
  res.status(403).json({
    ok: false,
    error: 'direct_llm_provider_route_disabled',
    message: 'Use /hub/llm/call with callerTeam + agent or selectorKey.',
  });
  return true;
}

// GET /hub/llm/jobs — 최근 비동기 LLM job 목록
export async function llmJobsListRoute(req: RouteReq, res: RouteRes) {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 20), 1), 100);
  return res.json({
    ok: true,
    jobs: await listLlmJobs(limit),
    store: await getJobStoreState(),
  });
}

// GET /hub/llm/jobs/:id — 비동기 LLM job 상태/결과 조회
export async function llmJobStatusRoute(req: RouteReq, res: RouteRes) {
  const job = await readJob(req.params?.id);
  if (!job) return res.status(404).json({ ok: false, error: 'llm_job_not_found' });
  return res.json({
    ok: true,
    job: redactJobPayload(job),
  });
}

// GET /hub/llm/jobs/:id/result — 완료된 비동기 LLM job 결과만 조회
export async function llmJobResultRoute(req: RouteReq, res: RouteRes) {
  const job = await readJob(req.params?.id);
  if (!job) return res.status(404).json({ ok: false, error: 'llm_job_not_found' });
  if (job.status !== 'completed') {
    return res.status(202).json({
      ok: false,
      status: job.status,
      jobId: job.id,
      retryAfterMs: job.retryAfterMs || 1_000,
    });
  }
  return res.json({
    ok: true,
    jobId: job.id,
    result: job.result,
  });
}

// POST /hub/llm/oauth — Claude Code OAuth 단독 호출
export async function llmOAuthRoute(req: RouteReq, res: RouteRes) {
  if (rejectIfDirectProviderRoutesDisabled(res)) return;
  const body = req.body ?? {};
  if (!body.prompt || typeof body.prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }

  try {
    const resp = await callClaudeCodeOAuth({
      prompt: body.prompt,
      model: body.model,
      systemPrompt: body.systemPrompt,
      jsonSchema: body.jsonSchema,
      timeoutMs: body.timeoutMs ?? 60_000,
      maxBudgetUsd: body.maxBudgetUsd,
    });
    return res.json(resp);
  } catch (err: any) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// POST /hub/llm/groq — Groq 단독 호출
export async function llmGroqRoute(req: RouteReq, res: RouteRes) {
  if (rejectIfDirectProviderRoutesDisabled(res)) return;
  const body = req.body ?? {};
  if (!body.prompt || typeof body.prompt !== 'string') {
    return res.status(400).json({ error: 'prompt (string) required' });
  }

  try {
    const resp = await callGroqFallback({
      prompt: body.prompt,
      model: body.model,
      systemPrompt: body.systemPrompt,
      jsonSchema: body.jsonSchema,
      jsonSchemaName: body.jsonSchemaName,
      strictJsonSchema: body.strictJsonSchema,
      responseFormat: body.responseFormat,
      reasoningEffort: body.reasoningEffort,
      reasoningFormat: body.reasoningFormat,
      includeReasoning: body.includeReasoning,
      seed: body.seed,
      serviceTier: body.serviceTier,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    });
    return res.json(resp);
  } catch (err: any) {
    return res.status(500).json({ ok: false, provider: 'failed', durationMs: 0, error: err.message });
  }
}

// GET /hub/llm/stats — provider × team × agent 다차원 집계
export async function llmStatsRoute(req: RouteReq, res: RouteRes) {
  const hours = Math.min(Math.max(Number(req.query?.hours ?? 24), 1), 168);
  const team = req.query?.team;

  const teamFilter = team ? 'AND caller_team = $2' : '';
  const params = team ? [hours, team] : [hours];

  try {
    const [summaryRes, byAgentRes, byHourRes] = await Promise.all([
      pgPool.query('public', `
        SELECT
          provider,
          caller_team,
          COUNT(*)                                                AS total_calls,
          SUM(CASE WHEN success THEN 1 ELSE 0 END)               AS success_count,
          ROUND(AVG(duration_ms))::integer                       AS avg_duration_ms,
          MAX(duration_ms)                                       AS max_duration_ms,
          ROUND(SUM(cost_usd)::numeric, 6)                       AS total_cost_usd,
          COUNT(DISTINCT agent)                                  AS unique_agents,
          SUM(fallback_count)                                    AS total_fallbacks
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
        GROUP BY provider, caller_team
        ORDER BY total_calls DESC
      `, params),
      pgPool.query('public', `
        SELECT agent, provider,
          COUNT(*)                                               AS calls,
          ROUND(AVG(duration_ms))::integer                      AS avg_ms,
          ROUND(SUM(cost_usd)::numeric, 6)                      AS cost
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
          AND agent IS NOT NULL
        GROUP BY agent, provider
        ORDER BY calls DESC
        LIMIT 20
      `, params),
      pgPool.query('public', `
        SELECT
          date_trunc('hour', created_at)                        AS hour,
          provider,
          COUNT(*)                                              AS calls,
          ROUND(SUM(cost_usd)::numeric, 6)                     AS cost
        FROM llm_routing_log
        WHERE created_at > NOW() - ($1 || ' hours')::interval ${teamFilter}
        GROUP BY hour, provider
        ORDER BY hour DESC
      `, params),
    ]);

    const summary = summaryRes;
    const totalCalls = summary.reduce((s: number, r: AnyRecord) => s + Number(r.total_calls), 0);
    const totalCost = summary.reduce((s: number, r: AnyRecord) => s + Number(r.total_cost_usd || 0), 0);
    const totalSuccess = summary.reduce((s: number, r: AnyRecord) => s + Number(r.success_count), 0);

    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary,
      by_agent: byAgentRes,
      by_hour: byHourRes,
      totals: {
        total_calls: totalCalls,
        total_cost_usd: totalCost,
        success_rate: totalCalls > 0 ? totalSuccess / totalCalls : 0,
        provider_share: computeProviderShare(summary),
      },
      admission: getLlmAdmissionState(),
      jobs: await getJobStoreState(),
    });
  } catch (err: any) {
    return res.json({
      ok: true,
      hours,
      team: team || 'all',
      groq_pool_size: loadGroqAccounts().length,
      summary: [],
      by_agent: [],
      by_hour: [],
      totals: { total_calls: 0, total_cost_usd: 0, success_rate: 0, provider_share: {} },
      admission: getLlmAdmissionState(),
      jobs: await getJobStoreState(),
      note: err.message.includes('does not exist') ? 'llm_routing_log 테이블 미생성 — 마이그레이션 필요' : undefined,
    });
  }
}

// GET /hub/llm/load-tests — 최근 부하 테스트 결과 조회
export async function llmLoadTestsRoute(req: RouteReq, res: RouteRes) {
  const limit = Math.min(Math.max(Number(req.query?.limit ?? 20), 1), 100);
  const scenario = req.query?.scenario;
  const whereClause = scenario ? 'WHERE scenario = $1' : '';
  const params = scenario ? [scenario, limit] : [limit];

  try {
    const [rows, scenarioRows] = await Promise.all([
      pgPool.query('public', `
        SELECT
          id,
          run_at,
          scenario,
          total_requests,
          failed_requests,
          fail_rate,
          p95_latency_ms AS p95_ms,
          p99_latency_ms AS p99_ms,
          avg_latency_ms AS avg_ms,
          duration_s,
          notes
        FROM hub.load_test_results
        ${whereClause}
        ORDER BY run_at DESC
        LIMIT $${params.length}
      `, params),
      pgPool.query('public', `
        SELECT DISTINCT ON (scenario)
          scenario,
          run_at,
          total_requests,
          failed_requests,
          fail_rate,
          p95_latency_ms AS p95_ms,
          p99_latency_ms AS p99_ms,
          avg_latency_ms AS avg_ms,
          duration_s,
          notes
        FROM hub.load_test_results
        ORDER BY scenario, run_at DESC
      `),
    ]);

    const normalizedRows = rows.map((row: AnyRecord) => ({
      ...row,
      notes: parseLoadTestNotes(row.notes),
    }));
    const scenarioSummary = scenarioRows.map((row: AnyRecord) => ({
      ...row,
      notes: parseLoadTestNotes(row.notes),
    }));
    const latest = normalizedRows[0] ?? null;
    return res.json({
      ok: true,
      count: normalizedRows.length,
      scenario: scenario || 'all',
      latest,
      scenario_summary: scenarioSummary,
      results: normalizedRows,
    });
  } catch (err: any) {
    return res.json({
      ok: true,
      count: 0,
      scenario: scenario || 'all',
      latest: null,
      scenario_summary: [],
      results: [],
      note: err.message.includes('does not exist') ? 'hub.load_test_results 테이블 미생성 — 마이그레이션 필요' : err.message,
    });
  }
}

// GET /hub/llm/circuit — local Ollama circuit breaker 상태 조회 + 리셋
export async function llmCircuitRoute(req: RouteReq, res: RouteRes) {
  if (req.method === 'DELETE') {
    const target = req.query?.target;
    const provider = req.query?.provider;
    if (provider) {
      const decoded = decodeURIComponent(provider);
      resetProviderCircuit(decoded);
      const cooldownReset = resetProviderCooldown(decoded);
      return res.json({ ok: true, reset_provider: decoded, reset_cooldowns: cooldownReset.reset });
    }
    if (target) {
      const decoded = decodeURIComponent(target);
      resetCircuit(decoded);
      return res.json({ ok: true, reset: decoded, reset_cooldowns: [] });
    }
    const resetLocal = resetAllCircuits();
    const resetProviders = resetAllProviderCircuits();
    const cooldownReset = resetProviderCooldown();
    return res.json({
      ok: true,
      reset: 'all',
      reset_local_circuits: resetLocal,
      reset_provider_circuits: resetProviders,
      reset_cooldowns: cooldownReset.reset,
    });
  }

  const statuses = getAllCircuitStatuses();
  const providerStats = getProviderStats();
  const providerCooldowns = getProviderCooldownSnapshot();
  const hasOpen = Object.values(statuses).some((s: any) => s.state === 'OPEN' || s.state === 'HALF_OPEN')
    || Object.values(providerStats).some((s: any) => s.state === 'OPEN')
    || Object.values(providerCooldowns).some((s: any) => s.cooling_down);
  return res.json({
    ok: true,
    local_llm_circuits: statuses,
    provider_circuits: providerStats,
    provider_cooldowns: providerCooldowns,
    any_open: hasOpen,
  });
}

function normalizeSelectorQueryValue(value: any): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const normalized = String(raw || '').trim();
  return normalized || undefined;
}

function compactSelectorChain(chain: AnyRecord[] = []): AnyRecord[] {
  return (Array.isArray(chain) ? chain : []).map((entry: AnyRecord = {}) => {
    const compacted: AnyRecord = {
      provider: entry.provider || null,
      model: entry.model || null,
      route: entry.route || (entry.provider && entry.model ? `${entry.provider}/${entry.model}` : null),
    };
    for (const key of ['maxTokens', 'temperature', 'timeoutMs', 'providerTier', 'fallbackIndex']) {
      if (entry[key] !== undefined && entry[key] !== null) compacted[key] = entry[key];
    }
    return compacted;
  });
}

// GET /hub/llm/selector — read-only Hub-owned selector chain inspection.
export async function llmSelectorRoute(req: RouteReq, res: RouteRes) {
  const selectorKey = normalizeSelectorQueryValue(req.query?.key || req.query?.selectorKey);
  if (!selectorKey) {
    return res.status(400).json({ ok: false, error: 'selector_key_required' });
  }

  const rolloutPercentRaw = normalizeSelectorQueryValue(req.query?.rolloutPercent);
  const options: AnyRecord = {
    agentName: normalizeSelectorQueryValue(req.query?.agentName || req.query?.agent),
    agent: normalizeSelectorQueryValue(req.query?.agent),
    taskType: normalizeSelectorQueryValue(req.query?.taskType || req.query?.task_type),
    task_type: normalizeSelectorQueryValue(req.query?.task_type || req.query?.taskType),
    runtimePurpose: normalizeSelectorQueryValue(req.query?.runtimePurpose || req.query?.runtime_purpose),
    runtime_purpose: normalizeSelectorQueryValue(req.query?.runtime_purpose || req.query?.runtimePurpose),
    selectorVersion: normalizeSelectorQueryValue(req.query?.selectorVersion) || 'v3.0_oauth_4',
    rolloutPercent: Number.isFinite(Number(rolloutPercentRaw)) ? Number(rolloutPercentRaw) : 100,
    rolloutKey: normalizeSelectorQueryValue(req.query?.rolloutKey) || `hub-selector-api:${selectorKey}`,
    team: normalizeSelectorQueryValue(req.query?.team || req.query?.callerTeam) || String(selectorKey).split('.')[0],
    callerTeam: normalizeSelectorQueryValue(req.query?.callerTeam || req.query?.team) || String(selectorKey).split('.')[0],
  };

  const selection = resolveHubLlmSelection({
    selectorKey,
    callerTeam: options.callerTeam,
    team: options.team,
    agent: options.agent || options.agentName,
    taskType: options.taskType,
    task_type: options.task_type,
    runtimePurpose: options.runtimePurpose,
    runtime_purpose: options.runtime_purpose,
    selectorVersion: options.selectorVersion,
    rolloutPercent: options.rolloutPercent,
    rolloutKey: options.rolloutKey,
    maxTokens: normalizeSelectorQueryValue(req.query?.maxTokens),
    temperature: normalizeSelectorQueryValue(req.query?.temperature),
  }, {
    shadowDeps: { mode: 'off' },
  });

  let description: AnyRecord = {};
  try {
    description = hubLlmSelector.describeLLMSelector?.(selectorKey, options) || {};
  } catch (_) {
    description = {};
  }

  const chain = compactSelectorChain(selection.chain || []);
  const selectorDisabled = description?.enabled === false && description?.kind === 'none';
  const timeoutProfile = description.timeoutProfile || selectorTimeoutProfiles.resolveSelectorTimeoutProfile(selectorKey, {
    fallbackTimeoutMs: chain[0]?.timeoutMs ?? null,
  });

  return res.status(selection.ok || selectorDisabled ? 200 : 409).json({
    ok: Boolean(selection.ok || selectorDisabled),
    mode: 'read_only_selector',
    selectorKey,
    enabled: !selectorDisabled,
    source: selection.source || null,
    routingSource: description.routingSource || selection.routingSource || null,
    runtimeProfile: selection.runtimeProfile || null,
    runtimePurpose: selection.runtimePurpose || null,
    routeTargetKind: selection.routeTargetKind || null,
    target: selection.target || null,
    error: selection.error || null,
    disabledProvidersRemoved: selection.disabledProvidersRemoved || 0,
    effectiveTimeoutMs: timeoutProfile?.timeoutMs ?? chain[0]?.timeoutMs ?? null,
    timeoutProfile,
    primary: chain[0] || null,
    fallbacks: chain.slice(1),
    chain,
    providerTiers: selection.providerTiers || [],
  });
}

function directProviderRoutesEnabled() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES || '').trim().toLowerCase());
}

function computeProviderShare(rows: AnyRecord[]): AnyRecord {
  const total = rows.reduce((s: number, r: AnyRecord) => s + Number(r.total_calls), 0);
  if (total === 0) return {};
  const share: AnyRecord = {};
  for (const r of rows) {
    share[r.provider] = (share[r.provider] || 0) + Number(r.total_calls) / total;
  }
  return share;
}

function parseLoadTestNotes(notes: unknown): unknown {
  if (!notes || typeof notes !== 'string') return notes;
  try {
    return JSON.parse(notes);
  } catch {
    return notes;
  }
}

function buildProviderBackpressure(resp: AnyRecord | null | undefined): AnyRecord | null {
  const error = String(resp?.error || '').toLowerCase();
  if (!error) return null;
  const provider = String(resp?.provider || '').trim() || undefined;
  if (error.includes('429') || error.includes('rate limit') || error.includes('quota')) {
    return {
      kind: 'provider_rate_limit',
      provider,
      retryAfterMs: Number(resp?.retryAfterMs || process.env.HUB_LLM_PROVIDER_RETRY_AFTER_MS || 60_000),
      httpStatus: 429,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  if (error.includes('provider_cooldown')) {
    return {
      kind: 'provider_cooldown',
      provider,
      retryAfterMs: Number(process.env.HUB_LLM_PROVIDER_RETRY_AFTER_MS || 60_000),
      httpStatus: 503,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  if (error.includes('provider_circuit_open')) {
    return {
      kind: 'provider_circuit_open',
      provider,
      retryAfterMs: Number(process.env.HUB_LLM_CIRCUIT_RETRY_AFTER_MS || 15_000),
      httpStatus: 503,
      provider_cooldowns: getProviderCooldownSnapshot(),
      provider_circuits: getProviderStats(),
    };
  }
  return null;
}

function normalizeVisionImage(body: AnyRecord): AnyRecord {
  let dataBase64 = String(body.imageBase64 || body.base64 || '').trim();
  let mimeType = String(body.mimeType || 'image/png').trim() || 'image/png';
  const dataUrl = String(body.imageDataUrl || body.dataUrl || '').trim();
  if (!dataBase64 && dataUrl) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
    if (match) {
      mimeType = match[1] || mimeType;
      dataBase64 = match[2] || '';
    }
  }
  dataBase64 = dataBase64.replace(/\s+/g, '');
  if (!dataBase64) return { ok: false, status: 400, error: 'image_required' };
  if (!/^image\/(png|jpe?g|webp)$/i.test(mimeType)) {
    return { ok: false, status: 400, error: 'unsupported_image_mime_type' };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    return { ok: false, status: 400, error: 'invalid_image_base64' };
  }
  let decoded = null;
  try {
    decoded = Buffer.from(dataBase64, 'base64');
  } catch {
    return { ok: false, status: 400, error: 'invalid_image_base64' };
  }
  const canonicalBase64 = decoded.toString('base64');
  if (canonicalBase64.replace(/=+$/g, '') !== dataBase64.replace(/=+$/g, '')) {
    return { ok: false, status: 400, error: 'invalid_image_base64' };
  }
  const bytes = decoded.byteLength;
  const maxBytes = Math.max(256_000, Number(process.env.HUB_LLM_VISION_MAX_BYTES || 5_000_000) || 5_000_000);
  if (bytes <= 0) return { ok: false, status: 400, error: 'empty_image' };
  if (bytes > maxBytes) return { ok: false, status: 413, error: 'image_too_large' };
  return {
    ok: true,
    dataBase64: canonicalBase64,
    mimeType,
    bytes,
    sha256: crypto.createHash('sha256').update(decoded).digest('hex'),
  };
}

function estimateVisionCostUsd(body: AnyRecord, image: AnyRecord, maxTokens: unknown): number {
  const explicit = Number(body.maxBudgetUsd || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const tokenCost = Math.max(0.01, Math.min(0.08, Number(maxTokens || 512) / 16_000));
  const imageCost = Math.max(0.005, Math.min(0.05, Number(image.bytes || 0) / 50_000_000));
  return Number((tokenCost + imageCost).toFixed(6));
}

function checkVisionBudget(team: string, estimatedCostUsd: number): AnyRecord {
  if (process.env.HUB_BUDGET_GUARDIAN_ENABLED === 'false') {
    return { ok: true, estimatedCostUsd, status: 'disabled' };
  }
  try {
    const { BudgetGuardian } = require('../budget-guardian');
    const check = BudgetGuardian.getInstance().checkAndReserve(team, estimatedCostUsd);
    return {
      ok: Boolean(check.ok),
      reason: check.reason || null,
      estimatedCostUsd,
      status: check.ok ? 'allowed' : 'blocked',
    };
  } catch (err: any) {
    console.warn('[llm] vision budget guardian 오류 (무시):', err.message);
    return { ok: true, estimatedCostUsd, status: 'error_ignored' };
  }
}

function resolveVisionSelection(request: AnyRecord): AnyRecord {
  const selection = resolveHubLlmSelection(request);
  if (!selection?.ok) {
    return {
      ok: false,
      status: 403,
      error: selection?.error || 'llm_selector_chain_required',
      selectorKey: selection?.selectorKey || null,
      providerTiers: selection?.providerTiers || [],
    };
  }
  const routes = (selection.chain || [])
    .map((entry: AnyRecord) => ({ entry, route: normalizeVisionRoute(entry.route || routeFromEntry(entry)) }))
    .filter((item: AnyRecord) => isVisionRouteSupported(item.route));
  if (!routes.length) {
    return {
      ok: false,
      status: 409,
      error: 'llm_vision_route_unavailable',
      selectorKey: selection.selectorKey || null,
      providerTiers: selection.providerTiers || [],
    };
  }
  return {
    ok: true,
    routes,
    selectorKey: selection.selectorKey || null,
    runtimeProfile: selection.runtimeProfile || null,
    runtimePurpose: selection.runtimePurpose || null,
    routeTargetKind: selection.routeTargetKind || selection.target?.kind || null,
    providerTiers: selection.providerTiers || [],
  };
}

function routeFromEntry(entry: AnyRecord): string {
  const provider = String(entry?.provider || '').trim();
  const model = String(entry?.model || '').trim();
  if (!provider || !model) return model || provider;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function normalizeVisionRoute(route: unknown): string {
  const normalized = String(route || '').trim();
  if (normalized.startsWith('openai/')) return `openai-oauth/${normalized.slice('openai/'.length)}`;
  if (normalized.startsWith('gemini/')) return `gemini-cli-oauth/${normalized.slice('gemini/'.length)}`;
  if (normalized.startsWith('gemini-oauth/')) return `gemini-cli-oauth/${normalized.slice('gemini-oauth/'.length)}`;
  if (normalized.startsWith('gemini-code-assist-oauth/')) {
    return `gemini-codeassist-oauth/${normalized.slice('gemini-code-assist-oauth/'.length)}`;
  }
  return normalized;
}

function isVisionRouteSupported(route: unknown): boolean {
  return String(route || '').startsWith('openai-oauth/')
    || String(route || '').startsWith('gemini-oauth/')
    || String(route || '').startsWith('gemini-cli-oauth/')
    || String(route || '').startsWith('gemini-codeassist-oauth/');
}

async function callVisionSelectorRoute(route: AnyRecord, input: AnyRecord): Promise<AnyRecord> {
  if (route.route.startsWith('openai-oauth/')) {
    return callOpenAiCodexOAuth({
      ...input,
      model: route.route.slice('openai-oauth/'.length),
    });
  }
  if (route.route.startsWith('gemini-oauth/')) {
    return callGeminiCliOAuth({
      ...input,
      model: route.route.slice('gemini-oauth/'.length),
    });
  }
  if (route.route.startsWith('gemini-cli-oauth/')) {
    return callGeminiCliOAuth({
      ...input,
      model: route.route.slice('gemini-cli-oauth/'.length),
    });
  }
  if (route.route.startsWith('gemini-codeassist-oauth/')) {
    return callGeminiCodeAssistOAuth({
      ...input,
      model: route.route.slice('gemini-codeassist-oauth/'.length),
    });
  }
  return { ok: false, provider: 'failed', error: `unsupported_vision_route:${route.route}`, durationMs: 0 };
}

function redactJobPayload(job: AnyRecord): AnyRecord {
  const { payload, ...rest } = job;
  return {
    ...rest,
    payloadSummary: job.payloadSummary,
  };
}

async function logRouting(resp: AnyRecord, body: AnyRecord): Promise<void> {
  const audit = buildRoutingLogAudit(body);
  const includeAudit = await ensureRoutingLogAuditColumns();
  const includeTrace = await routingLogTraceColumnsExist().catch(() => false);
  const includeStandard = await routingLogStandardColumnsExist().catch(() => false);
  try {
    await insertRoutingLog(resp, body, audit, { includeAudit, includeTrace, includeStandard });
  } catch (err: any) {
    if (
      (includeAudit && isRoutingLogAuditColumnError(err))
      || (includeTrace && isRoutingLogTraceColumnError(err))
      || (includeStandard && isRoutingLogStandardColumnError(err))
    ) {
      routingLogAuditColumnsPromise = null;
      routingLogTraceColumnsPromise = null;
      routingLogStandardColumnsPromise = null;
      await insertRoutingLog(resp, body, audit, { includeAudit: false, includeTrace: false, includeStandard: false });
      return;
    }
    throw err;
  }
}

async function insertRoutingLog(
  resp: AnyRecord,
  body: AnyRecord,
  audit: AnyRecord,
  flags: { includeAudit: boolean; includeTrace: boolean; includeStandard: boolean },
): Promise<void> {
  const providerForLog = resp?.dedupeHit ? 'dedupe' : resp.provider;
  const traceId = body.traceId ?? body.trace_id ?? resp.traceId ?? resp.trace_id ?? null;
  const cycleId = body.cycleId ?? body.cycle_id ?? resp.cycleId ?? resp.cycle_id ?? null;
  const columns = [
    'created_at',
    'provider',
    'agent',
    'caller_team',
    'abstract_model',
    'success',
    'duration_ms',
    'cost_usd',
    'fallback_count',
    'error',
    'session_id',
  ];
  const values = [
    'NOW()',
    '$1',
    '$2',
    '$3',
    '$4',
    '$5',
    '$6',
    '$7',
    '$8',
    '$9',
    '$10',
  ];
  const params: unknown[] = [
    providerForLog,
    body.agent ?? null,
    body.callerTeam ?? null,
    body.abstractModel,
    resp.ok,
    resp.durationMs,
    resp.totalCostUsd ?? 0,
    resp.fallbackCount ?? 0,
    resp.error ?? null,
    resp.sessionId ?? traceId ?? null,
  ];
  const addValue = (column: string, value: unknown, cast = '') => {
    params.push(value);
    columns.push(column);
    values.push(`$${params.length}${cast}`);
  };

  if (flags.includeAudit) {
    addValue('prompt_hash', audit.promptHash);
    addValue('system_prompt_hash', audit.systemPromptHash);
    addValue('request_fingerprint', audit.requestFingerprint);
    addValue('prompt_chars', audit.promptChars);
    addValue('selector_key', resp.selectorKey ?? body.selectorKey ?? null);
    addValue('selected_route', resp.selected_route ?? null);
    addValue('runtime_profile', resp.runtimeProfile ?? null);
    addValue('attempted_providers', JSON.stringify(Array.isArray(resp.attempted_providers) ? resp.attempted_providers : []), '::jsonb');
    addValue('avoided_providers', JSON.stringify(Array.isArray(resp.avoidedProviders) ? resp.avoidedProviders : []), '::jsonb');
    addValue('request_id', body.requestId ?? traceId ?? resp.sessionId ?? null);
    addValue('route_target_kind', resp.routeTargetKind ?? null);
    addValue('runtime_purpose', resp.runtimePurpose ?? body.runtimePurpose ?? body.runtime_purpose ?? body.taskType ?? body.task_type ?? null);
    addValue('estimated_cost_usd', Number(resp.estimatedCostUsd ?? body.estimatedCostUsd ?? body.estimated_cost_usd ?? 0) || 0);
    addValue('budget_guard_status', resp.budgetGuardStatus ?? null);
    addValue('provider_tier', resolveProviderTierForLog(resp));
  }

  if (flags.includeTrace) {
    addValue('trace_id', traceId);
    addValue('cycle_id', cycleId);
  }

  if (flags.includeStandard) {
    addValue('routing_source', resolveRoutingSourceForLog(resp, body));
    addValue('fallback_used', Boolean(resp.fallbackUsed ?? Number(resp.fallbackCount || 0) > 0));
    addValue('latency_ms', Number(resp.latencyMs ?? resp.durationMs ?? 0) || 0);
  }

  await pgPool.run('public', `
    INSERT INTO llm_routing_log (${columns.join(', ')})
    VALUES (${values.join(', ')})
  `, params);
}

function buildRoutingLogAudit(body: AnyRecord): AnyRecord {
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
  const systemPrompt = typeof body?.systemPrompt === 'string' ? body.systemPrompt : '';
  const promptHash = hashText(prompt);
  const systemPromptHash = hashText(systemPrompt);
  const requestFingerprint = hashText(JSON.stringify({
    callerTeam: body?.callerTeam ?? null,
    agent: body?.agent ?? null,
    taskType: body?.taskType ?? null,
    selectorKey: body?.selectorKey ?? null,
    abstractModel: body?.abstractModel ?? null,
    promptHash,
    systemPromptHash,
  }));
  return {
    promptHash,
    systemPromptHash,
    requestFingerprint,
    promptChars: prompt.length,
  };
}

function hashText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureRoutingLogAuditColumns(): Promise<boolean> {
  if (!routingLogAuditColumnsPromise) {
    routingLogAuditColumnsPromise = (async () => {
      if (await routingLogAuditColumnsExist()) {
        await ensureHubLlmRequestLogView();
        return true;
      }
      await pgPool.run('public', `
          ALTER TABLE llm_routing_log
            ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
            ADD COLUMN IF NOT EXISTS system_prompt_hash TEXT,
            ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
            ADD COLUMN IF NOT EXISTS prompt_chars INTEGER,
            ADD COLUMN IF NOT EXISTS selector_key TEXT,
            ADD COLUMN IF NOT EXISTS selected_route TEXT,
            ADD COLUMN IF NOT EXISTS runtime_profile TEXT,
            ADD COLUMN IF NOT EXISTS attempted_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS avoided_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS request_id TEXT,
            ADD COLUMN IF NOT EXISTS route_target_kind TEXT,
            ADD COLUMN IF NOT EXISTS runtime_purpose TEXT,
            ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION DEFAULT 0,
            ADD COLUMN IF NOT EXISTS budget_guard_status TEXT,
            ADD COLUMN IF NOT EXISTS provider_tier TEXT
        `);
      await createRoutingLogAuditIndexes();
      await ensureHubLlmRequestLogView();
      return true;
    })().catch((err) => {
      console.warn('[llm] routing log audit column ensure skipped:', err?.message || err);
      return false;
    });
  }
  return routingLogAuditColumnsPromise;
}

async function routingLogAuditColumnsExist() {
  const rows = await pgPool.query('public', `
    SELECT COUNT(*)::int AS count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
      AND column_name = ANY($1::text[])
  `, [[
    'prompt_hash',
    'system_prompt_hash',
    'request_fingerprint',
    'prompt_chars',
    'selector_key',
    'selected_route',
      'runtime_profile',
      'attempted_providers',
      'avoided_providers',
      'request_id',
      'route_target_kind',
      'runtime_purpose',
      'estimated_cost_usd',
      'budget_guard_status',
      'provider_tier',
    ]]);
  return Number(rows?.[0]?.count || 0) === 15;
}

function routingLogTraceColumnsExist(): Promise<boolean> {
  const stale = Date.now() - routingLogTraceColumnsCheckedAt > 60_000;
  if (!routingLogTraceColumnsPromise || stale) {
    routingLogTraceColumnsPromise = (async () => {
      const rows = await pgPool.query('public', `
        SELECT COUNT(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'llm_routing_log'
          AND column_name = ANY($1::text[])
      `, [['trace_id', 'cycle_id']]);
      routingLogTraceColumnsCheckedAt = Date.now();
      return Number(rows?.[0]?.count || 0) === 2;
    })().catch((err) => {
      routingLogTraceColumnsCheckedAt = 0;
      console.warn('[llm] routing log trace column check skipped:', err?.message || err);
      return false;
    });
  }
  return routingLogTraceColumnsPromise;
}

function routingLogStandardColumnsExist(): Promise<boolean> {
  const stale = Date.now() - routingLogStandardColumnsCheckedAt > 60_000;
  if (!routingLogStandardColumnsPromise || stale) {
    routingLogStandardColumnsPromise = (async () => {
      const rows = await pgPool.query('public', `
        SELECT COUNT(*)::int AS count
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'llm_routing_log'
          AND column_name = ANY($1::text[])
      `, [['routing_source', 'fallback_used', 'latency_ms']]);
      routingLogStandardColumnsCheckedAt = Date.now();
      return Number(rows?.[0]?.count || 0) === 3;
    })().catch((err) => {
      routingLogStandardColumnsCheckedAt = 0;
      console.warn('[llm] routing log standard column check skipped:', err?.message || err);
      return false;
    });
  }
  return routingLogStandardColumnsPromise;
}

async function createRoutingLogAuditIndexes() {
  try {
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_prompt_hash
        ON llm_routing_log (prompt_hash, created_at DESC)
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_request_fingerprint
        ON llm_routing_log (request_fingerprint, created_at DESC)
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_selector_key
        ON llm_routing_log (selector_key, created_at DESC)
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_selected_route
        ON llm_routing_log (selected_route, created_at DESC)
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_request_id
        ON llm_routing_log (request_id)
    `);
    await pgPool.run('public', `
      CREATE INDEX IF NOT EXISTS idx_llm_routing_log_runtime_purpose
        ON llm_routing_log (caller_team, runtime_purpose, created_at DESC)
    `);
  } catch (err: any) {
    console.warn('[llm] routing log audit index ensure skipped:', err?.message || err);
  }
}

async function ensureHubLlmRequestLogView() {
  await pgPool.run('public', `CREATE SCHEMA IF NOT EXISTS hub`);
  await pgPool.run('public', `
    CREATE OR REPLACE VIEW hub.llm_request_log AS
    SELECT
      id,
      COALESCE(request_id, session_id, id::text) AS request_id,
      created_at,
      provider,
      agent,
      caller_team,
      abstract_model,
      success,
      duration_ms,
      cost_usd,
      fallback_count,
      error,
      session_id,
      prompt_hash,
      system_prompt_hash,
      request_fingerprint,
      prompt_chars,
      selector_key,
      selected_route,
      runtime_profile,
      attempted_providers,
      avoided_providers,
      route_target_kind,
      runtime_purpose,
      estimated_cost_usd,
      budget_guard_status,
      provider_tier
    FROM public.llm_routing_log
  `);
}

function resolveProviderTierForLog(resp: AnyRecord): string | null {
  const tiers = Array.isArray(resp?.providerTiers) ? resp.providerTiers : [];
  const selectedRoute = String(resp?.selected_route || '');
  const selected = tiers.find((tier: AnyRecord) => tier.route === selectedRoute || tier.provider === resp?.provider);
  if (selected?.tier != null) return String(selected.tier);
  const provider = String(resp?.provider || '');
  if (provider === 'openai-oauth') return '1';
  if (provider === 'groq') return '2';
  if (provider === 'gemini-cli-oauth' || provider === 'gemini-oauth' || provider === 'gemini-codeassist-oauth') return '3';
  if (provider === 'local') return '4';
  if (provider === 'claude-code-oauth') return '5';
  return null;
}

function resolveRoutingSourceForLog(resp: AnyRecord, body: AnyRecord): string | null {
  const source = String(resp?.routingSource || body?.routingSource || resp?.source || body?.source || '').trim();
  if (source) return source;
  if (resp?.selectorKey || body?.selectorKey) return 'selector';
  if (resp?.runtimeProfile) return 'runtime_profile';
  if (resp?.selected_route || resp?.selectedRoute) return 'oauth4';
  return null;
}

function isRoutingLogAuditColumnError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  return message.includes('prompt_hash')
    || message.includes('system_prompt_hash')
    || message.includes('request_fingerprint')
    || message.includes('prompt_chars')
    || message.includes('selector_key')
    || message.includes('selected_route')
    || message.includes('runtime_profile')
    || message.includes('attempted_providers')
    || message.includes('avoided_providers')
    || message.includes('request_id')
    || message.includes('route_target_kind')
    || message.includes('runtime_purpose')
    || message.includes('estimated_cost_usd')
    || message.includes('budget_guard_status')
    || message.includes('provider_tier')
    || message.includes('column') && message.includes('does not exist');
}

function isRoutingLogTraceColumnError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  return message.includes('trace_id')
    || message.includes('cycle_id')
    || message.includes('column') && message.includes('does not exist');
}

function isRoutingLogStandardColumnError(err: unknown): boolean {
  const message = String((err as any)?.message || err || '').toLowerCase();
  return message.includes('routing_source')
    || message.includes('fallback_used')
    || message.includes('latency_ms')
    || message.includes('column') && message.includes('does not exist');
}
