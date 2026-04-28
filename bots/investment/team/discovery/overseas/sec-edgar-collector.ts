// @ts-nocheck
import type { DiscoveryAdapter, DiscoveryCollectOptions, DiscoveryResult, DiscoverySignal } from '../types.ts';

const SOURCE = 'sec_edgar';

const CIK_TO_SYMBOL = {
  '0000320193': 'AAPL',
  '0000789019': 'MSFT',
  '0001018724': 'AMZN',
  '0001326801': 'META',
  '0001652044': 'GOOGL',
  '0001045810': 'NVDA',
  '0001318605': 'TSLA',
};

function mockSignals() {
  return [
    { symbol: 'AAPL', score: 0.84, confidence: 0.82, reason: 'SEC 8-K mock: product launch', reasonCode: 'sec_8k_event' },
    { symbol: 'NVDA', score: 0.82, confidence: 0.79, reason: 'SEC 8-K mock: guidance update', reasonCode: 'sec_guidance' },
    { symbol: 'TSLA', score: 0.78, confidence: 0.75, reason: 'SEC 10-Q mock: earnings surprise', reasonCode: 'sec_earnings' },
  ].map((item) => ({ ...item, evidenceRef: {}, qualityFlags: ['sec_filing'] }));
}

function normalizeFormScore(form = '') {
  const v = String(form || '').toUpperCase();
  if (v === '8-K') return 0.84;
  if (v === '10-Q' || v === '10-K') return 0.78;
  if (v.includes('13D') || v.includes('13G')) return 0.72;
  if (v.includes('S-1')) return 0.66;
  return 0.58;
}

export class SecEdgarCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'overseas' as const;
  tier = 1 as const;
  reliability = 1.0;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const fetchedAt = new Date().toISOString();
    const { limit = 20, dryRun = false } = options;
    if (process.env.LUNA_DISCOVERY_SEC !== 'true' && !dryRun) {
      return mkResult(fetchedAt, [], 'insufficient');
    }
    if (dryRun) {
      return mkResult(fetchedAt, mockSignals().slice(0, limit), 'ready');
    }
    try {
      const filings = await fetchRecentFilings();
      const seen = new Map();
      for (const item of filings) {
        const symbol = CIK_TO_SYMBOL[String(item?.cik || '').padStart(10, '0')];
        if (!symbol) continue;
        const form = String(item?.form || '').trim();
        const score = normalizeFormScore(form);
        const confidence = Math.max(0.5, Math.min(0.92, score - 0.03));
        const prev = seen.get(symbol);
        const next = {
          symbol,
          score,
          confidence,
          reason: `SEC ${form} filing`,
          reasonCode: 'sec_filing',
          evidenceRef: {
            accessionNo: item?.accessionNumber || null,
            filedAt: item?.filedAt || null,
            form,
          },
          qualityFlags: ['sec_filing'],
          raw: item,
        };
        if (!prev || next.score > prev.score) seen.set(symbol, next);
      }
      const signals = Array.from(seen.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit));
      return mkResult(fetchedAt, signals, signals.length > 0 ? 'ready' : 'insufficient');
    } catch (error) {
      console.warn(`[sec-edgar-collector] failed: ${error?.message || error}`);
      return mkResult(fetchedAt, [], 'insufficient');
    }
  }
}

async function fetchRecentFilings() {
  const url = 'https://data.sec.gov/submissions/CIK0000320193.json';
  const headers = {
    'User-Agent': process.env.SEC_USER_AGENT || 'LunaDiscovery/1.0 (ops@local)',
    Accept: 'application/json',
  };
  const requests = Object.keys(CIK_TO_SYMBOL).map(async (cik) => {
    const endpoint = `https://data.sec.gov/submissions/CIK${cik}.json`;
    const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return [];
    const payload = await res.json();
    const recent = payload?.filings?.recent || {};
    const forms = Array.isArray(recent.form) ? recent.form : [];
    const accession = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
    const filed = Array.isArray(recent.filingDate) ? recent.filingDate : [];
    const out = [];
    for (let i = 0; i < Math.min(forms.length, 8); i++) {
      out.push({
        cik,
        form: forms[i],
        accessionNumber: accession[i] || null,
        filedAt: filed[i] || null,
      });
    }
    return out;
  });
  const settled = await Promise.allSettled(requests);
  return settled.flatMap((row) => (row.status === 'fulfilled' ? row.value : []));
}

function mkResult(
  fetchedAt: string,
  signals: DiscoverySignal[],
  status: 'ready' | 'degraded' | 'insufficient',
): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'overseas',
    fetchedAt,
    signals,
    quality: {
      status,
      sourceTier: 1,
      signalCount: signals.length,
    },
  };
}

export default SecEdgarCollector;
