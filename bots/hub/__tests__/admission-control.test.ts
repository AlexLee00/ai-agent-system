'use strict';

const { EventEmitter } = require('events');

function buildReq() {
  const req = new EventEmitter();
  req.method = 'POST';
  req.path = '/hub/llm/call';
  req.headers = {};
  req.once = req.once.bind(req);
  return req;
}

function buildRes() {
  const res = new EventEmitter();
  res.locals = {};
  res.headers = {};
  res.statusCode = 200;
  res.set = (key, value) => {
    res.headers[key] = value;
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.payload = payload;
    return res;
  };
  return res;
}

describe('hub llm admission-control', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.HUB_LLM_MAX_IN_FLIGHT = '1';
    process.env.HUB_LLM_MAX_QUEUE = '0';
    process.env.HUB_LLM_QUEUE_TIMEOUT_MS = '300';
    process.env.HUB_LLM_SHARED_LIMITER_ENABLED = '0';
  });

  afterEach(() => {
    delete process.env.HUB_LLM_MAX_IN_FLIGHT;
    delete process.env.HUB_LLM_MAX_QUEUE;
    delete process.env.HUB_LLM_QUEUE_TIMEOUT_MS;
    delete process.env.HUB_LLM_SHARED_LIMITER_ENABLED;
  });

  test('rejects with 429 when in-flight is full and queue disabled', async () => {
    const mod = require('../lib/llm/admission-control.ts');
    const { llmAdmissionMiddleware, getLlmAdmissionState } = mod;

    const req1 = buildReq();
    const res1 = buildRes();
    const next1 = jest.fn();
    await llmAdmissionMiddleware(req1, res1, next1);
    expect(next1).toHaveBeenCalled();
    expect(getLlmAdmissionState().in_flight).toBe(1);

    const req2 = buildReq();
    const res2 = buildRes();
    const next2 = jest.fn();
    await llmAdmissionMiddleware(req2, res2, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);
    expect(res2.payload?.error?.code).toBe('queue_full');

    res1.emit('finish');
    expect(getLlmAdmissionState().in_flight).toBe(0);
  });
});
