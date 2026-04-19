'use strict';

jest.mock('../../../packages/core/lib/env', () => ({
  HUB_BASE_URL: 'http://127.0.0.1:7788',
  HUB_AUTH_TOKEN: 'test-token',
  PROJECT_ROOT: '/mock/root',
  MODE: 'dev',
}));

global.fetch = jest.fn();

const client = require('../lib/hub-legal-client');

function mockOkResponse(data) {
  return Promise.resolve({
    json: () => Promise.resolve({ ok: true, ...data }),
  });
}

function mockErrorResponse(error, status = 400) {
  return Promise.resolve({
    json: () => Promise.resolve({ ok: false, error }),
    status,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('hub-legal-client — createCase', () => {
  it('POST /hub/legal/case 를 올바른 body로 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ case: { id: 1, case_number: 'TEST-001' } }));

    const result = await client.createCase({
      case_number: 'TEST-001',
      court: '서울중앙지방법원',
      case_type: 'copyright',
      plaintiff: '원고A',
      defendant: '피고B',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.case_number).toBe('TEST-001');
    expect(body.case_type).toBe('copyright');
    expect(result.ok).toBe(true);
    expect(result.case.id).toBe(1);
  });

  it('Hub 오류 응답 시 throw', async () => {
    global.fetch.mockReturnValueOnce(mockErrorResponse('case_number, court, plaintiff, defendant 필수'));

    await expect(client.createCase({})).rejects.toThrow('case_number, court, plaintiff, defendant 필수');
  });
});

describe('hub-legal-client — listCases', () => {
  it('status 필터 없이 GET /hub/legal/cases 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ total: 0, cases: [] }));

    const result = await client.listCases();
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/hub/legal/cases');
    expect(url).toContain('limit=50');
    expect(result.total).toBe(0);
  });

  it('status 필터 포함 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ total: 2, cases: [{}, {}] }));

    await client.listCases({ status: 'review', limit: 10 });
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('status=review');
    expect(url).toContain('limit=10');
  });
});

describe('hub-legal-client — getCase / getCaseStatus', () => {
  it('GET /hub/legal/case/:id 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ case: { id: 5 } }));

    const result = await client.getCase(5);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case/5');
    expect(result.case.id).toBe(5);
  });

  it('GET /hub/legal/case/:id/status 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ status: 'drafting', summary: {} }));

    const result = await client.getCaseStatus(3);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case/3/status');
    expect(result.status).toBe('drafting');
  });
});

describe('hub-legal-client — advanceCase / setCaseStatus', () => {
  it('advanceCase: action=advance 로 POST', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ new_status: 'analyzing' }));

    const result = await client.advanceCase(7);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case/7/approve');
    expect(JSON.parse(opts.body).action).toBe('advance');
    expect(result.new_status).toBe('analyzing');
  });

  it('setCaseStatus: action=status + target_status 로 POST', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ new_status: 'closed' }));

    await client.setCaseStatus(7, 'closed');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.action).toBe('status');
    expect(body.target_status).toBe('closed');
  });
});

describe('hub-legal-client — submitFeedback', () => {
  it('POST /hub/legal/case/:id/feedback 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ feedback: { id: 1 } }));

    const result = await client.submitFeedback(4, {
      court_decision: '원고 일부 승',
      appraisal_accuracy: 0.87,
      notes: '유사도 과대 평가',
    });

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case/4/feedback');
    const body = JSON.parse(opts.body);
    expect(body.court_decision).toBe('원고 일부 승');
    expect(body.appraisal_accuracy).toBe(0.87);
    expect(result.feedback.id).toBe(1);
  });
});

describe('hub-legal-client — getReport', () => {
  it('GET /hub/legal/case/:id/report?type=final 호출', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ report: { id: 1, version: 2 } }));

    const result = await client.getReport(9);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7788/hub/legal/case/9/report?type=final');
    expect(result.report.version).toBe(2);
  });

  it('inception_plan 타입 지정', async () => {
    global.fetch.mockReturnValueOnce(mockOkResponse({ report: { id: 2, report_type: 'inception_plan' } }));

    await client.getReport(9, 'inception_plan');
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('type=inception_plan');
  });
});

describe('hub-legal-client — 환경변수 미설정 시', () => {
  it('HUB_BASE_URL 없으면 throw', async () => {
    jest.resetModules();
    jest.mock('../../../packages/core/lib/env', () => ({
      HUB_BASE_URL: '',
      HUB_AUTH_TOKEN: 'test',
      PROJECT_ROOT: '/mock/root',
      MODE: 'dev',
    }));
    const c = require('../lib/hub-legal-client');
    await expect(c.createCase({})).rejects.toThrow('HUB_BASE_URL');
  });
});
