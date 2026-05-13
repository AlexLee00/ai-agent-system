'use strict';

function buildReq(overrides = {}) {
  return {
    headers: {},
    body: {},
    ...overrides,
  };
}

function buildRes() {
  return {
    locals: {},
    headers: {},
    set(key, value) {
      this.headers[key] = value;
      return this;
    },
  };
}

describe('hub request-context middleware', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('creates trace id and defaults priority', () => {
    const { hubRequestContextMiddleware } = require('../src/middleware/request-context.ts');
    const req = buildReq();
    const res = buildRes();
    const next = jest.fn();

    hubRequestContextMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.hubRequestContext.traceId).toBeTruthy();
    expect(req.hubRequestContext.priority).toBe('normal');
    expect(res.headers['X-Hub-Trace-Id']).toBe(req.hubRequestContext.traceId);
  });

  test('uses explicit header/body context values', () => {
    const { hubRequestContextMiddleware } = require('../src/middleware/request-context.ts');
    const req = buildReq({
      headers: {
        'x-trace-id': 'trace-test-001',
        'x-caller-team': 'blog',
        'x-agent': 'writer',
        'x-priority': 'critical',
      },
      body: {},
    });
    const res = buildRes();
    const next = jest.fn();

    hubRequestContextMiddleware(req, res, next);

    expect(req.hubRequestContext.traceId).toBe('trace-test-001');
    expect(req.hubRequestContext.callerTeam).toBe('blog');
    expect(req.hubRequestContext.agent).toBe('writer');
    expect(req.hubRequestContext.priority).toBe('critical');
  });

  test('accepts X-Hub-* aliases for external clients', () => {
    const { hubRequestContextMiddleware } = require('../src/middleware/request-context.ts');
    const req = buildReq({
      headers: {
        'x-hub-trace-id': 'trace-external-001',
        'x-hub-team': 'external-research',
        'x-hub-agent': 'article-writer',
        'x-hub-priority': 'high',
      },
      body: {},
    });
    const res = buildRes();
    const next = jest.fn();

    hubRequestContextMiddleware(req, res, next);

    expect(req.hubRequestContext.traceId).toBe('trace-external-001');
    expect(req.hubRequestContext.callerTeam).toBe('external-research');
    expect(req.hubRequestContext.agent).toBe('article-writer');
    expect(req.hubRequestContext.priority).toBe('high');
  });

  test('body values override external client header aliases', () => {
    const { hubRequestContextMiddleware } = require('../src/middleware/request-context.ts');
    const req = buildReq({
      headers: {
        'x-hub-team': 'external-research',
        'x-hub-agent': 'article-writer',
        'x-hub-priority': 'low',
      },
      body: {
        callerTeam: 'blog',
        agent: 'pos',
        urgency: 'critical',
      },
    });
    const res = buildRes();
    const next = jest.fn();

    hubRequestContextMiddleware(req, res, next);

    expect(req.hubRequestContext.callerTeam).toBe('blog');
    expect(req.hubRequestContext.agent).toBe('pos');
    expect(req.hubRequestContext.priority).toBe('critical');
  });
});
