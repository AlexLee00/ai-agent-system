import { z } from 'zod';

export const fxRateSchema = z.object({
  currency: z.string().describe('통화코드 (예: USD, JPY, EUR)').default('USD'),
  startDate: z.string().describe('조회 시작일 (YYYYMMDD)').optional(),
  endDate: z.string().describe('조회 종료일 (YYYYMMDD)').optional(),
});

const ECOS_BASE_URL = 'https://ecos.bok.or.kr/api/StatisticSearch';
const STAT_CODE = '036Y001'; // 주요국통화의대원화환율

export async function getFxRate(input: z.infer<typeof fxRateSchema>) {
  // API 키는 Hub secrets-store.json 경유 (하드코딩 금지!)
  const apiKey = process.env.BOK_ECOS_API_KEY;
  if (!apiKey) throw new Error('BOK_ECOS_API_KEY not configured in environment');

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const start = input.startDate || today;
  const end = input.endDate || today;
  const cur = input.currency || 'USD';

  const url = `${ECOS_BASE_URL}/${apiKey}/json/kr/1/100/${STAT_CODE}/D/${start}/${end}/${cur}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`ECOS API error: ${resp.status}`);

  const json = await resp.json() as Record<string, unknown>;
  const rows = (json?.StatisticSearch as { row?: unknown[] })?.row ?? [];

  return {
    currency: cur,
    period: { start, end },
    count: rows.length,
    rates: rows,
  };
}
