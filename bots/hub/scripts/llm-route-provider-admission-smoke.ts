const assert = require('node:assert/strict');

type CacheEntry = NodeJS.Module | undefined;

const ROUTE_MODULE = require.resolve('../lib/routes/llm.ts');

function createResponse() {
  return {
    locals: {},
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    status(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return body;
    },
  };
}

function installMock(modulePath: string, exports: unknown, originals: Map<string, CacheEntry>): void {
  const resolved = require.resolve(modulePath);
  if (!originals.has(resolved)) originals.set(resolved, require.cache[resolved]);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
}

function restoreMocks(originals: Map<string, CacheEntry>): void {
  delete require.cache[ROUTE_MODULE];
  for (const [resolved, original] of originals) {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  }
}

function loadRoutes(options: {
  routes?: string[];
  admission: (identity: Record<string, string>, execute: (context: { signal: AbortSignal; scopes: string[] }) => Promise<unknown>) => Promise<unknown>;
  createEmbeddingBatch?: (texts: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  callWithFallback?: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const originals = new Map<string, CacheEntry>();
  const calls: Array<{ provider: string; input: Record<string, unknown> }> = [];
  const routingRuns: Array<{ schema: string; sql: string; params?: unknown[] }> = [];
  const telemetryEvents: Array<{ stage: string; payload: Record<string, unknown> }> = [];
  const routes = options.routes || [];
  installMock('../../../packages/core/lib/pg-pool', {
    query: async () => ({ rows: [] }),
    run: async (schema: string, sql: string, params?: unknown[]) => {
      routingRuns.push({ schema, sql, params });
      return { rows: [], rowCount: 0 };
    },
  }, originals);
  installMock('../../../packages/core/lib/rag', {
    EMBED_MODEL: 'qwen3-embed-0.6b',
    createEmbeddingBatch: options.createEmbeddingBatch || (async () => [[0.1, 0.2]]),
  }, originals);
  installMock('../src/llm-selector', {
    isHubLlmRouteTargetAllowed: () => ({ ok: true }),
    resolveHubLlmSelection: () => ({
      ok: true,
      selectorKey: 'blog.vision',
      chain: routes.map((route) => ({ route })),
      providerTiers: [],
    }),
    isGeminiDisabled: () => false,
  }, originals);
  installMock('../lib/llm/oauth-direct', {
    callOpenAiCodexOAuth: async (input: Record<string, unknown>) => {
      calls.push({ provider: 'openai-oauth', input });
      return { ok: true, provider: 'openai-oauth', model: 'gpt-5.4', text: 'vision ok', durationMs: 1 };
    },
    callGeminiCliOAuth: async (input: Record<string, unknown>) => {
      calls.push({ provider: 'gemini-cli-oauth', input });
      return { ok: true, provider: 'gemini-cli-oauth', model: 'gemini-2.5-pro', text: 'vision ok', durationMs: 1 };
    },
    callGeminiCodeAssistOAuth: async (input: Record<string, unknown>) => {
      calls.push({ provider: 'gemini-codeassist-oauth', input });
      return { ok: true, provider: 'gemini-codeassist-oauth', model: 'gemini-2.5-pro', text: 'vision ok', durationMs: 1 };
    },
  }, originals);
  installMock('../lib/llm/claude-code-oauth', {
    callClaudeCodeOAuth: async (input: Record<string, unknown>) => {
      calls.push({ provider: 'claude-code-oauth', input });
      return { ok: true, provider: 'claude-code-oauth', result: 'oauth ok', durationMs: 1 };
    },
  }, originals);
  installMock('../lib/llm/groq-fallback', {
    callGroqFallback: async (input: Record<string, unknown>) => {
      calls.push({ provider: 'groq', input });
      return { ok: true, provider: 'groq', result: 'groq ok', durationMs: 1 };
    },
  }, originals);
  installMock('../lib/llm/provider-attempt-admission', {
    runWithProviderAdmission: options.admission,
  }, originals);
  installMock('../lib/llm/unified-caller', {
    callWithFallback: options.callWithFallback || (async () => ({ ok: false, error: 'not_configured' })),
  }, originals);
  installMock('../lib/telemetry', {
    recordHubTelemetry: (stage: string, payload: Record<string, unknown>) => {
      telemetryEvents.push({ stage, payload });
    },
  }, originals);
  installMock('../lib/budget-guardian', {
    BudgetGuardian: { getInstance: () => ({ checkAndReserve: () => ({ ok: true }) }) },
  }, originals);

  delete require.cache[ROUTE_MODULE];
  const module = require(ROUTE_MODULE);
  return { module, calls, routingRuns, telemetryEvents, restore: () => restoreMocks(originals) };
}

function visionRequest(traceId: string): {
  body: Record<string, unknown>;
  hubRequestContext: { traceId: string };
} {
  return {
    body: {
      callerTeam: 'blog',
      agent: 'writer',
      prompt: 'describe',
      imageBase64: Buffer.from('image').toString('base64'),
      mimeType: 'image/png',
    },
    hubRequestContext: { traceId },
  };
}

async function main(): Promise<void> {
  {
    const fixture = loadRoutes({
      admission: async (_identity, execute) => execute({ signal: new AbortController().signal, scopes: [] }),
      callWithFallback: async () => ({
        ok: false,
        provider: 'failed',
        error: 'shared_limiter_full:provider:openai-oauth',
        retryAfterMs: 1_500,
        admissionScope: 'provider:openai-oauth',
        limiterBackpressure: true,
        providerAttempted: false,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmCallRoute({
        body: {
          callerTeam: 'blog',
          agent: 'commenter',
          prompt: 'classify',
          abstractModel: 'anthropic_haiku',
        },
        hubRequestContext: { traceId: 'call-backpressure' },
      }, response);
      assert.equal(response.statusCode, 429);
      assert.equal(response.headers['Retry-After'], '2');
      assert.equal((response.body as Record<string, unknown>).limiterBackpressure, true);
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      admission: async (_identity, execute) => execute({ signal: new AbortController().signal, scopes: [] }),
      callWithFallback: async () => ({
        ok: true,
        provider: 'groq',
        result: 'ok',
        selected_route: 'groq/qwen/qwen3-32b',
        attempted_providers: [],
        fallbackCount: 0,
        admissionFallbackCount: 1,
        admissionRejections: [{
          provider: 'openai-oauth/gpt-5.4',
          error: 'shared_limiter_full:provider:openai-oauth',
          admissionScope: 'provider:openai-oauth',
          retryAfterMs: 900,
        }],
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmCallRoute({
        body: {
          callerTeam: 'darwin',
          agent: 'planner',
          prompt: 'admission fallback persistence',
          abstractModel: 'anthropic_sonnet',
        },
        hubRequestContext: { traceId: 'admission-fallback-persistence' },
      }, response);
      await new Promise((resolve) => setImmediate(resolve));
      const routingInsert = fixture.routingRuns.find((entry) => entry.sql.includes('INSERT INTO llm_routing_log'));
      if (!routingInsert) throw new Error('admission fallback must be written to routing log');
      const columnList = routingInsert.sql.match(/INSERT INTO llm_routing_log \(([^)]+)\)/s)?.[1] || '';
      const columns = columnList.split(',').map((column) => column.trim());
      const valueFor = (column: string) => routingInsert.params?.[columns.slice(1).indexOf(column)];
      assert.equal(valueFor('fallback_count'), 0, 'provider attempt fallback count semantics must stay unchanged');
      assert.equal(valueFor('admission_fallback_count'), 1);
      assert.deepEqual(JSON.parse(String(valueFor('admission_rejections') || '[]')), [{
        provider: 'openai-oauth/gpt-5.4',
        error: 'shared_limiter_full:provider:openai-oauth',
        admissionScope: 'provider:openai-oauth',
        retryAfterMs: 900,
      }]);
      const requestLogView = fixture.routingRuns.find((entry) => entry.sql.includes('CREATE OR REPLACE VIEW hub.llm_request_log'));
      const requestLogViewSql = String(requestLogView?.sql || '');
      assert.match(requestLogViewSql, /admission_fallback_count/);
      assert.match(requestLogViewSql, /admission_rejections/);
      assert.ok(
        requestLogViewSql.indexOf('provider_tier') < requestLogViewSql.indexOf('admission_rejections'),
        'new request-log view columns must append after the existing view contract',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      admission: async (_identity, execute) => execute({ signal: new AbortController().signal, scopes: [] }),
      callWithFallback: async () => ({
        ok: false,
        provider: 'failed',
        error: 'fallback_exhausted: provider rejected request',
        upstreamStatus: 429,
        retryAfterMs: 2_500,
        attempted_providers: ['groq/qwen/qwen3-32b'],
        fallbackCount: 1,
        admissionFallbackCount: 0,
        providerTerminationUnconfirmed: true,
        limiterLeaseQuarantined: true,
        limiterReleaseUncertain: true,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmCallRoute({
        body: {
          callerTeam: 'darwin',
          agent: 'planner',
          prompt: 'provider backpressure',
          abstractModel: 'anthropic_sonnet',
        },
        hubRequestContext: { traceId: 'provider-native-backpressure' },
      }, response);
      assert.equal(response.statusCode, 429, 'provider-native rate limits must preserve HTTP 429');
      assert.equal(response.headers['Retry-After'], '3');
      assert.equal((response.body as Record<string, any>).providerBackpressure?.kind, 'provider_rate_limit');
      const endEvent = fixture.telemetryEvents.find((event) => event.stage === 'llm_call_end');
      assert.equal(endEvent?.payload.errorCode, 'provider_rate_limit');
      assert.equal(endEvent?.payload.backpressureKind, 'provider_rate_limit');
      assert.equal(endEvent?.payload.retryAfterMs, 2_500);
      assert.equal(endEvent?.payload.admissionFallbackCount, 0);
      assert.equal(endEvent?.payload.providerTerminationUnconfirmed, true);
      assert.equal(endEvent?.payload.limiterLeaseQuarantined, true);
      assert.equal(endEvent?.payload.limiterReleaseUncertain, true);
      assert.equal('error' in (endEvent?.payload || {}), false, 'raw provider errors must not enter telemetry');
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      admission: async (_identity, execute) => execute({ signal: new AbortController().signal, scopes: [] }),
      callWithFallback: async () => ({
        ok: false,
        provider: 'failed',
        error: 'fallback_exhausted: upstream unavailable',
        upstreamStatus: 503,
        retryAfterMs: 3_000,
        attempted_providers: ['openai-oauth/gpt-5.4'],
        fallbackCount: 1,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmCallRoute({
        body: {
          callerTeam: 'blog',
          agent: 'writer',
          prompt: 'provider unavailable',
          abstractModel: 'anthropic_sonnet',
        },
        hubRequestContext: { traceId: 'provider-native-unavailable' },
      }, response);
      assert.equal(response.statusCode, 503, 'provider-native service unavailable must preserve HTTP 503');
      assert.equal(response.headers['Retry-After'], '3');
      assert.equal((response.body as Record<string, any>).providerBackpressure?.kind, 'provider_unavailable');
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      admission: async () => {
        throw new Error('provider_circuit_open:openai-oauth');
      },
      callWithFallback: async () => {
        throw new Error('provider_circuit_open:openai-oauth');
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmCallRoute({
        body: {
          callerTeam: 'blog',
          agent: 'writer',
          prompt: 'provider circuit',
          abstractModel: 'anthropic_sonnet',
        },
        hubRequestContext: { traceId: 'provider-circuit-backpressure' },
      }, response);
      assert.equal(response.statusCode, 503, 'provider circuit errors must preserve HTTP 503');
    } finally {
      fixture.restore();
    }
  }

  {
    const originalDirectRoutes = process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
    process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = 'true';
    const signal = new AbortController().signal;
    const identities: Array<Record<string, string>> = [];
    const fixture = loadRoutes({
      admission: async (identity, execute) => {
        identities.push(identity);
        return execute({ signal, scopes: [] });
      },
    });
    try {
      const oauthResponse = createResponse();
      await fixture.module.llmOAuthRoute({
        body: { callerTeam: 'blog', prompt: 'oauth direct', timeoutMs: 5_000 },
        hubRequestContext: { traceId: 'direct-oauth-admission' },
      }, oauthResponse);
      const groqResponse = createResponse();
      await fixture.module.llmGroqRoute({
        body: { callerTeam: 'darwin', prompt: 'groq direct', timeoutMs: 5_000 },
        hubRequestContext: { traceId: 'direct-groq-admission' },
      }, groqResponse);

      assert.equal(oauthResponse.statusCode, 200);
      assert.equal(groqResponse.statusCode, 200);
      assert.deepEqual(identities, [
        { team: 'blog', provider: 'claude-code-oauth' },
        { team: 'darwin', provider: 'groq' },
      ]);
      assert.equal(fixture.calls[0]?.provider, 'claude-code-oauth');
      assert.equal(fixture.calls[0]?.input.signal, signal);
      assert.equal(fixture.calls[1]?.provider, 'groq');
      assert.equal(fixture.calls[1]?.input.signal, signal);
    } finally {
      fixture.restore();
      if (originalDirectRoutes == null) delete process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
      else process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = originalDirectRoutes;
    }
  }

  {
    const originalDirectRoutes = process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
    process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = 'true';
    const fixture = loadRoutes({
      admission: async () => {
        throw new Error('HTTP 503 Service Unavailable');
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmOAuthRoute({
        body: { callerTeam: 'blog', prompt: 'oauth unavailable', timeoutMs: 5_000 },
        hubRequestContext: { traceId: 'direct-oauth-provider-unavailable' },
      }, response);
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['Retry-After'], '60');
    } finally {
      fixture.restore();
      if (originalDirectRoutes == null) delete process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
      else process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = originalDirectRoutes;
    }
  }

  {
    const originalDirectRoutes = process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
    process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = 'true';
    const fixture = loadRoutes({
      admission: async () => ({
        ok: false,
        provider: 'failed',
        error: 'upstream rejected request',
        upstreamStatus: 429,
        retryAfterMs: 1_200,
        providerAttempted: true,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmGroqRoute({
        body: { callerTeam: 'darwin', prompt: 'groq native backpressure', timeoutMs: 5_000 },
        hubRequestContext: { traceId: 'direct-groq-native-backpressure' },
      }, response);
      assert.equal(response.statusCode, 429, 'direct provider routes must preserve native rate-limit status');
      assert.equal(response.headers['Retry-After'], '2');
    } finally {
      fixture.restore();
      if (originalDirectRoutes == null) delete process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES;
      else process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES = originalDirectRoutes;
    }
  }

  {
    const signal = new AbortController().signal;
    const identities: Array<Record<string, string>> = [];
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4'],
      admission: async (identity, execute) => {
        identities.push(identity);
        return {
          ...(await execute({ signal, scopes: [] }) as Record<string, unknown>),
          limiterReleaseWarning: true,
          limiterReleaseUncertain: true,
          releaseError: 'shared_limiter_release_timeout',
        };
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-provider-admission'), response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(identities, [{ team: 'blog', provider: 'openai-oauth' }]);
      assert.equal(fixture.calls[0]?.input.signal, signal);
      assert.equal((response.body as Record<string, unknown>).limiterReleaseWarning, true);
      assert.equal((response.body as Record<string, unknown>).releaseError, 'shared_limiter_release_timeout');
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4'],
      admission: async () => ({
        ok: false,
        provider: 'failed',
        error: 'upstream rejected request',
        upstreamStatus: 429,
        retryAfterMs: 1_600,
        providerAttempted: true,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-provider-rate-limit'), response);
      assert.equal(response.statusCode, 429, 'vision must preserve provider-native rate-limit status');
      assert.equal(response.headers['Retry-After'], '2');
      assert.equal((response.body as Record<string, any>).providerBackpressure?.kind, 'provider_rate_limit');
      assert.equal((response.body as Record<string, unknown>).retryAfterMs, 1_600);
    } finally {
      fixture.restore();
    }
  }

  {
    const originalNow = Date.now;
    let now = 1_000;
    let admissionCalls = 0;
    Date.now = () => now;
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4', 'gemini-cli-oauth/gemini-2.5-pro'],
      admission: async () => {
        admissionCalls += 1;
        now = 6_000;
        return {
          ok: false,
          provider: 'openai-oauth',
          error: 'openai_timeout',
          durationMs: 5_000,
          providerAttempted: true,
        };
      },
    });
    try {
      const request = visionRequest('vision-total-deadline');
      request.body.timeoutMs = 5_000;
      const response = createResponse();
      await fixture.module.llmVisionRoute(request, response);
      assert.equal(admissionCalls, 1);
      assert.equal(response.statusCode, 504);
      assert.match(String((response.body as Record<string, unknown>).error || ''), /^llm_total_deadline_exceeded/);
    } finally {
      fixture.restore();
      Date.now = originalNow;
    }
  }

  {
    let admissionCalls = 0;
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4', 'gemini-cli-oauth/gemini-2.5-pro'],
      admission: async () => {
        admissionCalls += 1;
        return {
          ok: false,
          provider: 'failed',
          error: 'shared_limiter_full:team:blog',
          retryAfterMs: 2_000,
          admissionScope: 'team:blog',
          limiterBackpressure: true,
          providerAttempted: false,
        };
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-backpressure'), response);
      assert.equal(admissionCalls, 1);
      assert.equal(fixture.calls.length, 0);
      assert.equal(response.statusCode, 429);
      assert.equal(response.headers['Retry-After'], '2');
      assert.equal((response.body as Record<string, unknown>).limiterBackpressure, true);
      assert.equal((response.body as Record<string, unknown>).admissionScope, 'team:blog');
    } finally {
      fixture.restore();
    }
  }

  {
    let admissionCalls = 0;
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4', 'gemini-cli-oauth/gemini-2.5-pro'],
      admission: async () => {
        admissionCalls += 1;
        return {
          ok: false,
          provider: 'failed',
          error: 'shared_limiter_file_error:provider:openai-oauth',
          retryAfterMs: 1_000,
          admissionScope: 'provider:openai-oauth',
          limiterBackpressure: true,
          providerAttempted: false,
        };
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-limiter-error'), response);
      assert.equal(admissionCalls, 1);
      assert.equal(response.statusCode, 503);
      assert.equal(response.headers['Retry-After'], '1');
      assert.equal(fixture.calls.length, 0);
    } finally {
      fixture.restore();
    }
  }

  {
    const signal = new AbortController().signal;
    const identities: Array<Record<string, string>> = [];
    const fixture = loadRoutes({
      routes: ['openai-oauth/gpt-5.4', 'gemini-cli-oauth/gemini-2.5-pro'],
      admission: async (identity, execute) => {
        identities.push(identity);
        if (identity.provider === 'openai-oauth') {
          return {
            ok: false,
            provider: 'failed',
            error: 'shared_limiter_full:provider:openai-oauth',
            retryAfterMs: 500,
            admissionScope: 'provider:openai-oauth',
            limiterBackpressure: true,
            providerAttempted: false,
          };
        }
        return execute({ signal, scopes: [] });
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-provider-fallback'), response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(identities, [
        { team: 'blog', provider: 'openai-oauth' },
        { team: 'blog', provider: 'gemini-cli-oauth' },
      ]);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.calls[0]?.provider, 'gemini-cli-oauth');
      assert.equal(fixture.calls[0]?.input.signal, signal);
    } finally {
      fixture.restore();
    }
  }

  {
    const signal = new AbortController().signal;
    const identities: Array<Record<string, string>> = [];
    const fixture = loadRoutes({
      routes: [
        'openai-oauth/gpt-5.4',
        'openai-oauth/gpt-5.4-mini',
        'gemini-cli-oauth/gemini-2.5-pro',
      ],
      admission: async (identity, execute) => {
        identities.push(identity);
        if (identity.provider === 'openai-oauth') {
          return {
            ok: false,
            provider: 'failed',
            error: 'shared_limiter_full:provider:openai-oauth',
            retryAfterMs: 500,
            admissionScope: 'provider:openai-oauth',
            limiterBackpressure: true,
            providerAttempted: false,
          };
        }
        return execute({ signal, scopes: [] });
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmVisionRoute(visionRequest('vision-same-provider-skip'), response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(identities, [
        { team: 'blog', provider: 'openai-oauth' },
        { team: 'blog', provider: 'gemini-cli-oauth' },
      ]);
      assert.deepEqual((response.body as Record<string, unknown>).attempted_providers, []);
      assert.equal((response.body as Record<string, unknown>).fallbackCount, 0);
      assert.equal((response.body as Record<string, unknown>).admissionFallbackCount, 1);
      assert.deepEqual((response.body as Record<string, unknown>).admissionRejections, [{
        provider: 'openai-oauth/gpt-5.4',
        error: 'shared_limiter_full:provider:openai-oauth',
        admissionScope: 'provider:openai-oauth',
        retryAfterMs: 500,
      }]);
    } finally {
      fixture.restore();
    }
  }

  {
    const signal = new AbortController().signal;
    const identities: Array<Record<string, string>> = [];
    const embeddingCalls: Array<{ texts: string[]; options?: { signal?: AbortSignal } }> = [];
    const fixture = loadRoutes({
      admission: async (identity, execute) => {
        identities.push(identity);
        return {
          ...(await execute({ signal, scopes: [] }) as Record<string, unknown>),
          limiterReleaseWarning: true,
          limiterReleaseUncertain: true,
          releaseError: 'shared_limiter_release_timeout',
        };
      },
      createEmbeddingBatch: async (texts, options) => {
        embeddingCalls.push({ texts, options });
        return [[0.1, 0.2]];
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmEmbeddingsRoute({
        body: { callerTeam: 'blog', agent: 'rag-writer', input: ['hello'] },
        hubRequestContext: { traceId: 'embedding-provider-admission' },
      }, response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(identities, [{ team: 'blog', provider: 'local-embedding' }]);
      assert.deepEqual(embeddingCalls[0]?.texts, ['hello']);
      assert.equal(embeddingCalls[0]?.options?.signal, signal);
      assert.equal((response.body as Record<string, unknown>).limiterReleaseWarning, true);
      assert.equal((response.body as Record<string, unknown>).releaseError, 'shared_limiter_release_timeout');
    } finally {
      fixture.restore();
    }
  }

  {
    let embeddingCalls = 0;
    const fixture = loadRoutes({
      admission: async () => ({
        ok: false,
        provider: 'failed',
        error: 'shared_limiter_full:provider:local-embedding',
        retryAfterMs: 750,
        admissionScope: 'provider:local-embedding',
        limiterBackpressure: true,
        providerAttempted: false,
      }),
      createEmbeddingBatch: async () => {
        embeddingCalls += 1;
        return [[0.1, 0.2]];
      },
    });
    try {
      const response = createResponse();
      await fixture.module.llmEmbeddingsRoute({
        body: { callerTeam: 'blog', agent: 'rag-writer', input: ['hello'] },
        hubRequestContext: { traceId: 'embedding-backpressure' },
      }, response);
      assert.equal(response.statusCode, 429);
      assert.equal(response.headers['Retry-After'], '1');
      assert.equal(embeddingCalls, 0);
      await new Promise((resolve) => setImmediate(resolve));
      const routingInsert = fixture.routingRuns.find((entry) => entry.sql.includes('INSERT INTO llm_routing_log'));
      if (!routingInsert) throw new Error('embedding admission rejection must be written to routing log');
      assert.equal(routingInsert.params?.[0], 'local-embedding');
      assert.equal(routingInsert.params?.[4], false);
      assert.match(String(routingInsert.params?.[8] || ''), /^shared_limiter_full:/);
      assert.match(String(routingInsert.params?.[8] || ''), /retry_after_ms=750/);
    } finally {
      fixture.restore();
    }
  }

  {
    const fixture = loadRoutes({
      admission: async () => ({
        ok: false,
        provider: 'failed',
        error: 'llm_total_deadline_exceeded:provider_attempt',
        durationMs: 5_000,
        providerAttempted: true,
      }),
    });
    try {
      const response = createResponse();
      await fixture.module.llmEmbeddingsRoute({
        body: { callerTeam: 'blog', agent: 'rag-writer', input: ['hello'] },
        hubRequestContext: { traceId: 'embedding-provider-timeout' },
      }, response);
      assert.equal(response.statusCode, 504);
      await new Promise((resolve) => setImmediate(resolve));
      const routingInsert = fixture.routingRuns.find((entry) => entry.sql.includes('INSERT INTO llm_routing_log'));
      if (!routingInsert) throw new Error('embedding provider timeout must be written to routing log');
      assert.equal(routingInsert.params?.[7], 1);
      assert.deepEqual(JSON.parse(String(routingInsert.params?.[17] || '[]')), ['local/qwen3-embed-0.6b']);
    } finally {
      fixture.restore();
    }
  }

  console.log('llm route provider admission smoke: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
