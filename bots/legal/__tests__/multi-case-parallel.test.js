'use strict';

const path = require('path');
process.env.PROJECT_ROOT = path.resolve(__dirname, '../../..');

// mock 변수는 'mock' 접두어가 있어야 factory 내에서 허용됨
let mockIdSeq = 1;
const mockCreatedCases = [];

jest.mock('../lib/appraisal-store', () => ({
  createCase: jest.fn().mockImplementation(async (input) => {
    const record = { id: mockIdSeq++, ...input, status: 'received', created_at: new Date() };
    mockCreatedCases.push(record);
    return record;
  }),
  getCaseById:      jest.fn(),
  updateCaseStatus: jest.fn(),
  saveInterview:    jest.fn(),
  getLatestReport:  jest.fn(),
  listCases:        jest.fn(),
}));

jest.mock('../lib/llm-helper', () => ({
  callLegal: jest.fn(),
}));

jest.mock('../lib/briefing', () => ({
  analyzeCaseAndRequirements: jest.fn(),
  writeInceptionPlan:         jest.fn(),
  writeQueryLetter:           jest.fn(),
  writeInspectionPlan:        jest.fn(),
}));

jest.mock('../../../packages/core/lib/env', () => ({
  PROJECT_ROOT: require('path').resolve(__dirname, '../../..'),
  MODE: 'test',
}));

jest.mock('../../../packages/core/lib/rag', () => ({ store: jest.fn() }), { virtual: true });
jest.mock('../../../packages/core/lib/telegram-sender', () => ({ send: jest.fn() }), { virtual: true });

const { callLegal } = require('../lib/llm-helper');
const justin        = require('../lib/justin');

describe('멀티 사건 병렬 접수', () => {
  beforeAll(async () => {
    mockIdSeq = 1;
    mockCreatedCases.length = 0;

    callLegal.mockImplementation(async ({ userPrompt }) => {
      if (userPrompt.includes('저작권'))
        return { text: '{"case_type":"copyright","analysis_needed":["lens"],"complexity":"high","key_issues":[],"reasoning":""}' };
      if (userPrompt.includes('하자'))
        return { text: '{"case_type":"defect","analysis_needed":["garam"],"complexity":"medium","key_issues":[],"reasoning":""}' };
      if (userPrompt.includes('계약'))
        return { text: '{"case_type":"contract","analysis_needed":["contro"],"complexity":"medium","key_issues":[],"reasoning":""}' };
      return { text: '{"case_type":"other","analysis_needed":[],"complexity":"low","key_issues":[],"reasoning":""}' };
    });

    const inputs = [
      { case_number: '2026가합001', court: '서울', plaintiff: 'A', defendant: 'B', appraisal_items: ['저작권 침해 여부'] },
      { case_number: '2026나합002', court: '부산', plaintiff: 'C', defendant: 'D', appraisal_items: ['SW 하자 여부'] },
      { case_number: '2026다합003', court: '대구', plaintiff: 'E', defendant: 'F', appraisal_items: ['계약 위반 여부'] },
    ];

    await Promise.allSettled(inputs.map(i => justin.receiveCase(i)));
  });

  test('3건 동시 접수 시 DB createCase가 3번 호출된다', () => {
    const mockStore = require('../lib/appraisal-store');
    expect(mockStore.createCase).toHaveBeenCalledTimes(3);
  });

  test('각 사건의 case_number가 독립적으로 저장된다', () => {
    const numbers = mockCreatedCases.map(c => c.case_number);
    expect(new Set(numbers).size).toBe(3);
  });

  test('copyright 사건은 lens가 required에 포함된다', () => {
    const copyright = mockCreatedCases.find(c => c.case_type === 'copyright');
    expect(copyright).toBeDefined();
    expect(copyright.assigned_agents.required).toContain('lens');
  });

  test('defect 사건은 lens가 required에 없다', () => {
    const defect = mockCreatedCases.find(c => c.case_type === 'defect');
    expect(defect).toBeDefined();
    expect(defect.assigned_agents.required).not.toContain('lens');
  });

  test('contract 사건은 contro가 required에 포함된다', () => {
    const contract = mockCreatedCases.find(c => c.case_type === 'contract');
    expect(contract).toBeDefined();
    expect(contract.assigned_agents.required).toContain('contro');
  });

  test('모든 사건의 classification_source가 llm이다', () => {
    for (const c of mockCreatedCases) {
      expect(c.assigned_agents.classification_source).toBe('llm');
    }
  });
});
