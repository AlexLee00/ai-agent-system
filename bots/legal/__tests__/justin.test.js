'use strict';

// LLM/DB 연결 없이 모듈 구조만 검증하는 테스트
jest.mock('../lib/llm-helper', () => ({ callLegal: jest.fn() }));
jest.mock('../lib/appraisal-store', () => ({
  createCase: jest.fn(),
  getCaseById: jest.fn(),
  getCaseByCaseNumber: jest.fn(),
  updateCaseStatus: jest.fn(),
  listCases: jest.fn().mockResolvedValue([]),
}));
jest.mock('../lib/briefing', () => ({ analyzeCaseAndRequirements: jest.fn(), writeInceptionPlan: jest.fn(), writeQueryLetter: jest.fn() }));
jest.mock('../lib/lens', () => ({ analyzeSourceCode: jest.fn() }));
jest.mock('../lib/garam', () => ({ searchDomesticCases: jest.fn() }));
jest.mock('../lib/atlas', () => ({ searchForeignCases: jest.fn() }));
jest.mock('../lib/claim', () => ({ analyzePlaintiff: jest.fn() }));
jest.mock('../lib/defense', () => ({ analyzeDefendant: jest.fn() }));
jest.mock('../lib/quill', () => ({ writeFinalReport: jest.fn() }));
jest.mock('../lib/balance', () => ({ reviewReport: jest.fn() }));

const justin = require('../lib/justin');

describe('justin (팀장) 모듈 구조', () => {
  const EXPECTED_EXPORTS = [
    'receiveCase', 'classifyCase',
    'runPhase2', 'runPhase2_5', 'runPhase3', 'runPhase4_LensAnalysis',
    'runPhase12', 'runFullWorkflow',
    'writeInceptionPlan', 'writeQueryLetter', 'getStatus',
  ];

  test.each(EXPECTED_EXPORTS)('%s가 함수로 export됨', (name) => {
    expect(typeof justin[name]).toBe('function');
  });
});

describe('justin.getStatus', () => {
  test('활성 사건 없을 때 empty 구조 반환', async () => {
    const store = require('../lib/appraisal-store');
    store.listCases.mockResolvedValue([]);
    const status = await justin.getStatus();
    expect(status.active_cases).toBe(0);
    expect(Array.isArray(status.cases)).toBe(true);
  });

  test('사건 있을 때 요약 필드 포함', async () => {
    const store = require('../lib/appraisal-store');
    store.listCases.mockResolvedValue([
      { id: 1, case_number: '서울중앙지방법원 2026가합12345', case_type: 'copyright', status: 'analyzing', deadline: null },
    ]);
    const status = await justin.getStatus();
    expect(status.active_cases).toBe(1);
    expect(status.cases[0].case_number).toBe('서울중앙지방법원 2026가합12345');
  });
});
