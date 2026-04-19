'use strict';

const path = require('path');
process.env.PROJECT_ROOT = path.resolve(__dirname, '../../..');

// Jest mock factory에서는 path를 사용할 수 없으므로 상대 경로 사용
jest.mock('../lib/appraisal-store', () => ({
  createCase:        jest.fn(),
  getCaseById:       jest.fn(),
  updateCaseStatus:  jest.fn(),
  saveInterview:     jest.fn(),
  getLatestReport:   jest.fn(),
  listCases:         jest.fn(),
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

const mockStore    = require('../lib/appraisal-store');
const { callLegal } = require('../lib/llm-helper');
const briefing     = require('../lib/briefing');
const rag          = require('../../../packages/core/lib/rag');
const justin       = require('../lib/justin');

describe('classifyCase (LLM fallback)', () => {
  afterEach(() => jest.clearAllMocks());

  test('유효한 JSON 응답을 파싱한다', async () => {
    callLegal.mockResolvedValue({
      text: '{"case_type":"copyright","analysis_needed":["lens"],"complexity":"high","key_issues":["유사도"],"reasoning":"테스트"}',
    });
    const result = await justin.classifyCase('저작권 침해', ['소스코드 유사도 비교']);
    expect(result.case_type).toBe('copyright');
    expect(result.key_issues).toContain('유사도');
  });

  test('JSON 파싱 실패 시 other로 폴백한다', async () => {
    callLegal.mockResolvedValue({ text: '분류 불가 — 정보 부족' });
    const result = await justin.classifyCase('', []);
    expect(result.case_type).toBe('other');
  });
});

describe('receiveCase (assigned_agents 저장)', () => {
  afterEach(() => jest.clearAllMocks());

  test('copyright 사건은 lens를 required에 포함한 assigned_agents를 저장한다', async () => {
    callLegal.mockResolvedValue({
      text: '{"case_type":"copyright","analysis_needed":["lens","garam"],"complexity":"high","key_issues":[],"reasoning":""}',
    });
    mockStore.createCase.mockResolvedValue({
      id: 1, case_number: '2026가합001', case_type: 'copyright', status: 'received',
    });

    await justin.receiveCase({
      case_number: '2026가합001', court: '서울중앙지방법원',
      plaintiff: '원고A', defendant: '피고B', appraisal_items: ['소스코드 유사도 비교'],
    });

    const callArg = mockStore.createCase.mock.calls[0][0];
    expect(callArg.assigned_agents).toBeDefined();
    expect(callArg.assigned_agents.required).toContain('lens');
    expect(callArg.assigned_agents.classification_source).toBe('llm');
  });
});

describe('recordInterview', () => {
  afterEach(() => jest.clearAllMocks());

  test('1차 인터뷰는 interview1 상태로 전환한다', async () => {
    mockStore.saveInterview.mockResolvedValue({ id: 10 });
    mockStore.updateCaseStatus.mockResolvedValue();

    await justin.recordInterview(1, 1, { question: 'Q1', response: 'R1', analysis: 'A1' });

    expect(mockStore.saveInterview).toHaveBeenCalledWith(
      expect.objectContaining({ interview_type: 'query1_interview', case_id: 1 })
    );
    expect(mockStore.updateCaseStatus).toHaveBeenCalledWith(1, 'interview1');
  });

  test('2차 인터뷰는 interview2 상태로 전환한다', async () => {
    mockStore.saveInterview.mockResolvedValue({ id: 11 });
    mockStore.updateCaseStatus.mockResolvedValue();

    await justin.recordInterview(2, 2, { question: 'Q2', response: 'R2' });

    expect(mockStore.updateCaseStatus).toHaveBeenCalledWith(2, 'interview2');
  });
});

describe('writeInspectionPlan', () => {
  afterEach(() => jest.clearAllMocks());

  test('상태를 inspection_plan으로 바꾸고 briefing에 위임한다', async () => {
    mockStore.updateCaseStatus.mockResolvedValue();
    briefing.writeInspectionPlan.mockResolvedValue({ content_md: '계획서 내용' });

    const result = await justin.writeInspectionPlan(5, { case_number: '2026나합999' });

    expect(mockStore.updateCaseStatus).toHaveBeenCalledWith(5, 'inspection_plan');
    expect(briefing.writeInspectionPlan).toHaveBeenCalledWith(5, expect.objectContaining({ case_number: '2026나합999' }));
    expect(result).toHaveProperty('content_md');
  });
});

describe('submitCase', () => {
  afterEach(() => jest.clearAllMocks());

  test('최종 보고서를 RAG에 적재하고 status를 submitted로 바꾼다', async () => {
    mockStore.getCaseById.mockResolvedValue({
      id: 3, case_number: '2026가합003', case_type: 'defect', court: '부산지방법원',
    });
    mockStore.getLatestReport.mockResolvedValue({
      content_md: '# 감정서', version: 1, review_status: 'justin_reviewed',
    });
    mockStore.updateCaseStatus.mockResolvedValue();
    rag.store.mockResolvedValue('rag-id-xyz');

    const result = await justin.submitCase(3, { signedBy: 'Alex Lee' });

    expect(rag.store).toHaveBeenCalledWith(
      'rag_legal',
      expect.any(String),
      expect.objectContaining({ case_number: '2026가합003', signed_by: 'Alex Lee' }),
      'justin'
    );
    expect(mockStore.updateCaseStatus).toHaveBeenCalledWith(3, 'submitted');
    expect(result.status).toBe('submitted');
  });

  test('존재하지 않는 사건은 오류를 던진다', async () => {
    mockStore.getCaseById.mockResolvedValue(null);
    await expect(justin.submitCase(999)).rejects.toThrow('찾을 수 없습니다');
  });
});
