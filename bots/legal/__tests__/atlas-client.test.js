'use strict';

const atlasClient = require('../lib/atlas-client');

function makeFetchMock(payload, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    text: jest.fn().mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: jest.fn().mockResolvedValue(payload),
  });
}

describe('atlas-client', () => {
  afterEach(() => {
    global.fetch = undefined;
  });

  describe('searchUsOpinions', () => {
    test('정상 응답 — opinions 정규화', async () => {
      const mockPayload = {
        count: 2,
        results: [
          {
            cluster_id: 'C001',
            caseNameFull: 'Oracle America, Inc. v. Google LLC',
            citation: ['141 S. Ct. 1183'],
            court: 'Supreme Court',
            docketNumber: '18-956',
            dateFiled: '2021-04-05',
            absolute_url: '/opinion/123/',
            judge: 'Thomas',
            opinions: [{ id: 'OP1', snippet: 'Copyright in software APIs...' }],
            meta: { score: { bm25: 9.5 } },
          },
          {
            cluster_id: 'C002',
            caseName: 'Lotus v. Borland',
            citation: ['49 F.3d 807'],
            court: '1st Circuit',
            dateFiled: '1995-03-09',
            absolute_url: '/opinion/456/',
            opinions: [],
            meta: { score: { bm25: 7.2 } },
          },
        ],
      };
      global.fetch = makeFetchMock(mockPayload);

      const result = await atlasClient.searchUsOpinions('software copyright');

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        id: 'C001',
        caseName: 'Oracle America, Inc. v. Google LLC',
        citation: '141 S. Ct. 1183',
        court: 'Supreme Court',
        dateFiled: '2021-04-05',
        absoluteUrl: 'https://www.courtlistener.com/opinion/123/',
        snippet: 'Copyright in software APIs...',
        score: 9.5,
      });
    });

    test('limit 옵션으로 결과 개수 제한', async () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        cluster_id: `C${i}`,
        caseName: `Case ${i}`,
        opinions: [],
        meta: { score: { bm25: i } },
      }));
      global.fetch = makeFetchMock({ count: 10, results: items });

      const result = await atlasClient.searchUsOpinions('test', { limit: 3 });

      expect(result.items).toHaveLength(3);
    });

    test('검색어 + order_by URL 파라미터 확인', async () => {
      global.fetch = makeFetchMock({ count: 0, results: [] });

      await atlasClient.searchUsOpinions('source code similarity', { orderBy: 'dateFiled desc' });

      const url = global.fetch.mock.calls[0][0].toString();
      expect(url).toContain('courtlistener.com');
      expect(url).toContain('q=source+code+similarity');
      expect(url).toContain('type=o');
      expect(url).toContain('order_by=dateFiled+desc');
    });

    test('빈 결과 — total 0, items 빈 배열', async () => {
      global.fetch = makeFetchMock({ count: 0, results: [] });

      const result = await atlasClient.searchUsOpinions('nonexistent');
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    test('HTTP 오류 시 throw', async () => {
      global.fetch = makeFetchMock('Unauthorized', false, 401);

      await expect(atlasClient.searchUsOpinions('test')).rejects.toThrow('HTTP 401');
    });

    test('opinions 없는 항목 — snippet 빈 문자열', async () => {
      global.fetch = makeFetchMock({
        count: 1,
        results: [{ cluster_id: 'X1', caseName: 'NoOpinion', opinions: null, meta: {} }],
      });

      const result = await atlasClient.searchUsOpinions('test');
      expect(result.items[0].snippet).toBe('');
      expect(result.items[0].score).toBe(0);
    });

    test('citation 배열 여러 개 — 세미콜론으로 결합', async () => {
      global.fetch = makeFetchMock({
        count: 1,
        results: [{ cluster_id: 'M1', citation: ['100 F.3d 1', '200 U.S. 500'], opinions: [], meta: {} }],
      });

      const result = await atlasClient.searchUsOpinions('test');
      expect(result.items[0].citation).toBe('100 F.3d 1; 200 U.S. 500');
    });

    test('absolute_url 없으면 absoluteUrl 빈 문자열', async () => {
      global.fetch = makeFetchMock({
        count: 1,
        results: [{ cluster_id: 'N1', opinions: [], meta: {} }],
      });

      const result = await atlasClient.searchUsOpinions('test');
      expect(result.items[0].absoluteUrl).toBe('');
    });

    test('results가 배열이 아니면 items 빈 배열', async () => {
      global.fetch = makeFetchMock({ count: 0, results: null });

      const result = await atlasClient.searchUsOpinions('test');
      expect(result.items).toEqual([]);
    });

    test('AbortController timeout — AbortError 전파', async () => {
      global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));

      await expect(atlasClient.searchUsOpinions('test', { timeoutMs: 10 })).rejects.toThrow('The operation was aborted.');
    });
  });
});
