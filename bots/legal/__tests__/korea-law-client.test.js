'use strict';

jest.mock('../../../packages/core/lib/legal-credentials.js', () => ({
  resolveKoreaLawCredentials: jest.fn(),
}));

const { resolveKoreaLawCredentials } = require('../../../packages/core/lib/legal-credentials.js');
const koreaLawClient = require('../lib/korea-law-client');

const MOCK_CREDS = { oc: 'TEST_OC', baseUrl: 'https://www.law.go.kr', userId: 'uid1', userName: 'uname1' };

function makeFetchMock(payload, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
  });
}

describe('korea-law-client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveKoreaLawCredentials.mockResolvedValue(MOCK_CREDS);
  });

  afterEach(() => {
    global.fetch = undefined;
  });

  describe('searchLaws', () => {
    test('정상 응답 — 법령 목록 반환', async () => {
      const mockPayload = {
        LawSearch: {
          키워드: '저작권',
          totalCnt: '2',
          page: '1',
          law: [
            { 법령ID: 'L001', 법령명한글: '저작권법', 법령구분명: '법률', 소관부처명: '문화체육관광부', 공포일자: '20230101', 시행일자: '20230201', 법령상세링크: '/link1' },
            { LSID: 'L002', LM: '컴퓨터프로그램보호법', 법종구분: '법률', 소관부처: '과기부', 공포일자: '20220101', 시행일자: '20220201', 법령상세링크: '/link2' },
          ],
        },
      };
      global.fetch = makeFetchMock(mockPayload);

      const result = await koreaLawClient.searchLaws('저작권');

      expect(result.keyword).toBe('저작권');
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({ id: 'L001', nameKo: '저작권법', ministry: '문화체육관광부' });
      expect(result.items[1]).toMatchObject({ id: 'L002', nameKo: '컴퓨터프로그램보호법' });
    });

    test('OC 파라미터 포함 URL 생성 확인', async () => {
      global.fetch = makeFetchMock({ LawSearch: { totalCnt: '0', law: [] } });

      await koreaLawClient.searchLaws('test', { display: 5, page: 2 });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const calledUrl = global.fetch.mock.calls[0][0].toString();
      expect(calledUrl).toContain('OC=TEST_OC');
      expect(calledUrl).toContain('target=law');
      expect(calledUrl).toContain('query=test');
      expect(calledUrl).toContain('display=5');
      expect(calledUrl).toContain('page=2');
    });

    test('빈 law 배열 — items 빈 배열 반환', async () => {
      global.fetch = makeFetchMock({ LawSearch: { totalCnt: '0', law: [] } });

      const result = await koreaLawClient.searchLaws('없는법');
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    test('law 단일 객체(배열 아님) — 정상 처리', async () => {
      const mockPayload = {
        LawSearch: {
          totalCnt: '1',
          law: { 법령ID: 'S001', 법령명한글: '단일법령', 법령구분명: '법률', 소관부처명: '부처', 공포일자: '20230101', 시행일자: '20230201', 법령상세링크: '/s1' },
        },
      };
      global.fetch = makeFetchMock(mockPayload);

      const result = await koreaLawClient.searchLaws('단일');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('S001');
    });

    test('HTTP 오류 시 throw', async () => {
      global.fetch = makeFetchMock('Bad Request', false, 400);

      await expect(koreaLawClient.searchLaws('test')).rejects.toThrow('HTTP 400');
    });

    test('OC 미설정 시 throw', async () => {
      resolveKoreaLawCredentials.mockResolvedValue({ oc: '', baseUrl: '', userId: '', userName: '' });

      await expect(koreaLawClient.searchLaws('test')).rejects.toThrow('korea law credentials not configured');
    });

    test('JSON 파싱 실패 시 throw', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: jest.fn().mockResolvedValue('NOT_JSON'),
      });

      await expect(koreaLawClient.searchLaws('test')).rejects.toThrow('JSON parse failed');
    });
  });

  describe('searchPrecedents', () => {
    test('정상 응답 — 판례 목록 반환', async () => {
      const mockPayload = {
        PrecSearch: {
          키워드: '소프트웨어',
          totalCnt: '1',
          page: '1',
          prec: [
            {
              판례일련번호: 'P001',
              사건번호: '2023다1234',
              사건명: '저작권침해',
              법원명: '대법원',
              법원종류코드: 'GD0001',
              선고일자: '20231201',
              사건종류명: '민사',
              판결유형: '판결',
              판례상세링크: '/prec/P001',
              판결요지: '소프트웨어 저작권 침해 인정',
            },
          ],
        },
      };
      global.fetch = makeFetchMock(mockPayload);

      const result = await koreaLawClient.searchPrecedents('소프트웨어');

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: 'P001',
        caseNumber: '2023다1234',
        caseName: '저작권침해',
        court: '대법원',
        decisionDate: '20231201',
        summary: '소프트웨어 저작권 침해 인정',
      });
    });

    test('target=prec 파라미터 포함 URL 확인', async () => {
      global.fetch = makeFetchMock({ PrecSearch: { totalCnt: '0', prec: [] } });

      await koreaLawClient.searchPrecedents('test', { display: 3 });

      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('target=prec');
      expect(url).toContain('OC=TEST_OC');
      expect(url).toContain('display=3');
    });

    test('판례정보일련번호 폴백 ID 처리', async () => {
      const mockPayload = {
        PrecSearch: {
          totalCnt: '1',
          prec: [{ 판례정보일련번호: 'PI999', 사건번호: '99나9999', 사건명: '테스트', 법원명: '서울고법', 선고일자: '20220101', 판시사항: '판시사항 요지' }],
        },
      };
      global.fetch = makeFetchMock(mockPayload);

      const result = await koreaLawClient.searchPrecedents('테스트');
      expect(result.items[0].id).toBe('PI999');
      expect(result.items[0].summary).toBe('판시사항 요지');
    });
  });

  describe('fetchLawDetail', () => {
    test('ID 파라미터로 상세 요청', async () => {
      global.fetch = makeFetchMock({ LawService: { 법령명한글: '저작권법', 조문: [] } });

      const result = await koreaLawClient.fetchLawDetail({ id: 'L001', mst: 'M001' });

      expect(result).toHaveProperty('LawService');
      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('target=law');
      expect(url).toContain('ID=L001');
      expect(url).toContain('MST=M001');
    });
  });

  describe('fetchPrecedentDetail', () => {
    test('판례 ID로 상세 요청', async () => {
      global.fetch = makeFetchMock({ PrecService: { 사건번호: '2023다1234' } });

      const result = await koreaLawClient.fetchPrecedentDetail('P001');

      expect(result).toHaveProperty('PrecService');
      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('target=prec');
      expect(url).toContain('ID=P001');
    });
  });

  describe('getAuth baseUrl 우선순위', () => {
    test('credentials.baseUrl이 비어 있으면 DEFAULT_BASE_URL 사용', async () => {
      resolveKoreaLawCredentials.mockResolvedValue({ oc: 'OC1', baseUrl: '', userId: '', userName: '' });
      global.fetch = makeFetchMock({ LawSearch: { totalCnt: '0', law: [] } });

      await koreaLawClient.searchLaws('test');

      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('www.law.go.kr');
    });

    test('credentials.baseUrl이 있으면 해당 URL 사용', async () => {
      resolveKoreaLawCredentials.mockResolvedValue({ oc: 'OC1', baseUrl: 'https://custom.law.kr', userId: '', userName: '' });
      global.fetch = makeFetchMock({ LawSearch: { totalCnt: '0', law: [] } });

      await koreaLawClient.searchLaws('test');

      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('custom.law.kr');
    });
  });
});
