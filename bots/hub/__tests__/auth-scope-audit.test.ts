'use strict';

describe('Hub scoped auth audit mode', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../lib/telemetry.ts', () => ({ recordHubTelemetry: jest.fn() }));
    process.env.HUB_AUTH_TOKEN = 'legacy-root-token';
    process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON = JSON.stringify([
      {
        principalId: 'blog-worker',
        team: 'blog',
        scopes: ['llm:invoke'],
      },
    ]);
  });

  afterEach(() => {
    delete process.env.HUB_AUTH_TOKEN;
    delete process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON;
  });

  function response() {
    return {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };
  }

  test('simulates scoped enforcement without changing legacy authentication', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'POST',
      path: '/hub/llm/call',
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'blog-worker',
      },
      body: {
        callerTeam: 'luna',
        policyOverride: { chain: [{ provider: 'groq' }] },
      },
      hubRequestContext: {},
    };
    const next = jest.fn();

    authMiddleware(req, response(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.hubAuthPrincipal).toMatchObject({ principalId: 'legacy-root', legacy: true });
    expect(req.hubAuthAudit).toMatchObject({
      principalId: 'blog-worker',
      authenticatedPrincipalId: 'legacy-root',
      simulatedScopedPrincipal: true,
    });
    expect(req.hubAuthAudit.wouldDeny).toBe(true);
    expect(req.hubAuthAudit.reasons).toEqual(expect.arrayContaining([
      'caller_team_mismatch',
      'missing_scope:llm:policy_override',
    ]));
    expect(req.hubRequestContext.authPrincipalId).toBe('legacy-root');
  });

  test('does not accept a scoped token before enforcement is introduced', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'POST',
      path: '/hub/llm/call',
      headers: { authorization: 'Bearer blog-worker-token' },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };
    const res = response();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: 'invalid_bearer_token' });
  });

  test('keeps the existing legacy bearer behavior unchanged', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'GET',
      path: '/hub/secrets/config',
      headers: { authorization: 'Bearer legacy-root-token' },
      body: {},
      hubRequestContext: {},
    };
    const next = jest.fn();

    authMiddleware(req, response(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.hubAuthPrincipal).toMatchObject({ principalId: 'legacy-root', legacy: true });
    expect(req.hubAuthAudit.wouldDeny).toBe(false);
    expect(req.hubAuthAudit.reasons).toContain('legacy_unscoped_principal');
  });

  test('uses the original mounted URL when Express trims req.path', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'POST',
      path: '/llm/call',
      originalUrl: '/hub/llm/call',
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'blog-worker',
      },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());

    expect(req.hubAuthAudit.path).toBe('/hub/llm/call');
    expect(req.hubAuthAudit.requiredScopes).toContain('llm:invoke');
  });

  test('throttles repeated scoped audit telemetry for the same decision', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const { recordHubTelemetry } = require('../lib/telemetry.ts');
    const req = {
      method: 'POST',
      originalUrl: '/hub/llm/call',
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'blog-worker',
      },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());
    authMiddleware(req, response(), jest.fn());

    expect(recordHubTelemetry).toHaveBeenCalledTimes(1);
  });

  test('treats luna as the investment auth identity without changing the request team', () => {
    process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON = JSON.stringify([
      {
        principalId: 'investment-worker',
        team: 'investment',
        scopes: ['llm:invoke'],
      },
    ]);
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'POST',
      originalUrl: '/hub/llm/call',
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'investment-worker',
      },
      body: { callerTeam: 'luna' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());

    expect(req.body.callerTeam).toBe('luna');
    expect(req.hubAuthAudit.claimedTeam).toBe('luna');
    expect(req.hubAuthAudit.reasons).not.toContain('caller_team_mismatch');
    expect(req.hubAuthAudit.wouldDeny).toBe(false);
  });

  test.each([
    ['POST', '/hub/pg/query', 'pg:query'],
    ['POST', '/hub/oauth/openai-oauth/refresh', 'oauth:manage'],
    ['GET', '/hub/oauth/openai-oauth/status', 'oauth:read'],
    ['DELETE', '/hub/llm/circuit', 'llm:control'],
    ['GET', '/hub/llm/stats', 'llm:read'],
    ['POST', '/hub/llm/call', 'llm:invoke'],
    ['GET', '/hub/tools', 'control:read'],
  ])('classifies %s %s as %s in audit-only mode', (method, path, expectedScope) => {
    process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON = JSON.stringify([
      {
        principalId: 'audit-worker',
        team: 'blog',
        scopes: ['*'],
      },
    ]);
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method,
      originalUrl: path,
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'audit-worker',
      },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());

    expect(req.hubAuthAudit.requiredScopes).toContain(expectedScope);
  });

  test.each([
    ['POST', '/hub/tasks'],
    ['PATCH', '/hub/tasks/task-1'],
    ['POST', '/hub/agents/hire'],
    ['POST', '/hub/legal/case/case-1/approve'],
    ['POST', '/hub/budget/reserve'],
  ])('requires a write scope for unmatched mutation %s %s', (method, path) => {
    process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON = JSON.stringify([
      {
        principalId: 'read-only-worker',
        team: 'blog',
        scopes: ['hub:access'],
      },
    ]);
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method,
      originalUrl: path,
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'read-only-worker',
      },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());

    expect(req.hubAuthAudit.requiredScopes).toContain('hub:write');
    expect(req.hubAuthAudit.reasons).toContain('missing_scope:hub:write');
    expect(req.hubAuthAudit.wouldDeny).toBe(true);
  });

  test('keeps safe unmatched routes on the read scope', () => {
    const { authMiddleware } = require('../lib/auth.ts');
    const req = {
      method: 'GET',
      originalUrl: '/hub/tasks',
      headers: {
        authorization: 'Bearer legacy-root-token',
        'x-hub-audit-principal-id': 'blog-worker',
      },
      body: { callerTeam: 'blog' },
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());

    expect(req.hubAuthAudit.requiredScopes).toEqual(['hub:access']);
  });

  test('marks malformed scoped-principal configuration as audit degraded without exposing the raw value', () => {
    process.env.HUB_AUTH_SCOPED_PRINCIPALS_JSON = '{malformed-secret-json';
    const { authMiddleware } = require('../lib/auth.ts');
    const { recordHubTelemetry } = require('../lib/telemetry.ts');
    const req = {
      method: 'GET',
      originalUrl: '/hub/tasks',
      headers: { authorization: 'Bearer legacy-root-token' },
      body: {},
      hubRequestContext: {},
    };

    authMiddleware(req, response(), jest.fn());
    authMiddleware(req, response(), jest.fn());

    expect(req.hubAuthAudit.scopedPrincipalAuditDegraded).toBe(true);
    expect(req.hubAuthAudit.scopedPrincipalConfigError).toBe('invalid_json');
    const configEvents = recordHubTelemetry.mock.calls.filter(([stage]) => stage === 'hub.auth.scope_config_error');
    expect(configEvents).toHaveLength(1);
    expect(configEvents[0][1]).toMatchObject({ severity: 'warn', reason: 'invalid_json' });
    expect(JSON.stringify(configEvents[0][1])).not.toContain('malformed-secret-json');
  });
});
