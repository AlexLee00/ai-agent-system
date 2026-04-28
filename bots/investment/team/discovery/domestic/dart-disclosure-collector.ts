// @ts-nocheck
// DART 전자공시 어댑터 — 국내장 tier1, 신뢰도 1.0, 무료 API
// 공시 발생 = 시장 이벤트 (M&A, 실적, 지분변동 등) → 후보로 등록
// 환경변수: DART_API_KEY (dart.fss.or.kr 발급)
// Kill switch: LUNA_DISCOVERY_DART=false

import type { DiscoveryAdapter, DiscoveryResult, DiscoveryCollectOptions, DiscoverySignal } from '../types.ts';

const DART_BASE_URL = 'https://opendart.fss.or.kr/api';
const SOURCE = 'dart_disclosure';
const TIMEOUT_MS = 5000;
const RETRY_MAX = 1;

// 투자 관련 공시 코드 (이벤트 중요도 순)
const HIGH_IMPACT_CODES = new Set([
  'DNAF',  // 주요사항보고서 (M&A, 대규모 투자)
  'DRCR',  // 최대주주 변경
  'DSCF',  // 자기주식 취득
  'DWRG',  // 전환사채/신주인수권부사채
]);
const MEDIUM_IMPACT_CODES = new Set([
  'DRGR',  // 주요경영사항 (사업부 매각, 공장 신설 등)
  'DCFQ',  // 사업보고서/실적 공시
  'DPIF',  // 주요주주 지분 변동
]);

export class DartDisclosureCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'domestic' as const;
  tier = 1 as const;
  reliability = 1.0;

  private apiKey: string;

  constructor() {
    this.apiKey = process.env.DART_API_KEY || '';
  }

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const { limit = 50, timeoutMs = TIMEOUT_MS, dryRun = false } = options;
    const fetchedAt = new Date().toISOString();

    if (!process.env.LUNA_DISCOVERY_DART || process.env.LUNA_DISCOVERY_DART === 'false') {
      return mkResult(fetchedAt, [], 'insufficient', 'kill_switch_off');
    }

    if (dryRun) {
      return mkResult(fetchedAt, buildMockSignals(), 'ready', 'dry_run');
    }

    if (!this.apiKey) {
      console.log('[dart-collector] DART_API_KEY 없음 → mock 반환');
      return mkResult(fetchedAt, buildMockSignals(), 'degraded', 'no_api_key');
    }

    for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
      try {
        const signals = await this.fetchDisclosures(limit, timeoutMs);
        const status = signals.length >= 3 ? 'ready' : signals.length > 0 ? 'degraded' : 'insufficient';
        console.log(`[dart-collector] ${signals.length}개 공시 신호 수집`);
        return mkResult(fetchedAt, signals, status);
      } catch (err) {
        if (attempt === RETRY_MAX) {
          console.log(`[dart-collector] 수집 실패 (시도 ${attempt + 1}): ${err?.message}`);
          return mkResult(fetchedAt, [], 'insufficient', err?.message);
        }
        await sleep(1000);
      }
    }

    return mkResult(fetchedAt, [], 'insufficient');
  }

  private async fetchDisclosures(limit: number, timeoutMs: number): Promise<DiscoverySignal[]> {
    const today = fmtDate(new Date());
    const weekAgo = fmtDate(new Date(Date.now() - 7 * 86400_000));

    const url = `${DART_BASE_URL}/list.json?crtfc_key=${this.apiKey}&bgn_de=${weekAgo}&end_de=${today}&sort=date&sort_mth=desc&page_no=1&page_count=${Math.min(limit, 100)}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let data: unknown;
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'LunaDiscovery/1.0' } });
      data = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const items: unknown[] = (data as any)?.list || [];
    const signals: DiscoverySignal[] = [];

    for (const item of items) {
      const corp = (item as any);
      const symbol = corp.stock_code?.trim();
      if (!symbol || symbol.length !== 6) continue;  // 코스피/코스닥 6자리만

      const reportCode = corp.report_nm || '';
      const score = scoreDisclosure(reportCode);
      if (score === 0) continue;

      signals.push({
        symbol,
        score,
        reason: `DART: ${corp.corp_name} — ${corp.report_nm}`,
        raw: {
          corp_name: corp.corp_name,
          report_nm: corp.report_nm,
          rcept_dt: corp.rcept_dt,
          rcept_no: corp.rcept_no,
        },
      });
    }

    // 종목별 최고점수만 (동일 종목 중복 공시 통합)
    const seen = new Map<string, DiscoverySignal>();
    for (const s of signals) {
      const prev = seen.get(s.symbol);
      if (!prev || s.score > prev.score) seen.set(s.symbol, s);
    }

    return Array.from(seen.values());
  }
}

function scoreDisclosure(reportNm: string): number {
  const nm = reportNm.toUpperCase();
  // 주요사항보고서 계열 (인수합병, 대규모 투자)
  if (nm.includes('주요사항') || nm.includes('주요경영')) return 0.85;
  // 최대주주 변경
  if (nm.includes('최대주주')) return 0.80;
  // 실적 발표 (잠정, 연결, 별도)
  if (nm.includes('실적') || nm.includes('영업실적')) return 0.75;
  // 자기주식 취득 (주가 부양 신호)
  if (nm.includes('자기주식취득')) return 0.72;
  // 전환사채/신주인수권부사채 (희석 리스크 but 자금조달 이벤트)
  if (nm.includes('전환사채') || nm.includes('신주인수권')) return 0.65;
  // 지분 변동 (5% 이상)
  if (nm.includes('지분') && nm.includes('변동')) return 0.65;
  // 사업보고서 (정기)
  if (nm.includes('사업보고서') || nm.includes('분기보고서')) return 0.60;
  return 0;
}

function buildMockSignals(): DiscoverySignal[] {
  return [
    { symbol: '005930', score: 0.85, reason: 'DART mock: 삼성전자 — 주요사항보고서 (HBM 투자)', raw: {} },
    { symbol: '000660', score: 0.75, reason: 'DART mock: SK하이닉스 — 잠정실적 공시', raw: {} },
    { symbol: '035420', score: 0.65, reason: 'DART mock: 네이버 — 전환사채 발행', raw: {} },
  ];
}

function mkResult(
  fetchedAt: string,
  signals: DiscoverySignal[],
  status: 'ready' | 'degraded' | 'insufficient',
  _meta?: string,
): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'domestic',
    fetchedAt,
    signals,
    quality: { status, sourceTier: 1, signalCount: signals.length },
  };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default DartDisclosureCollector;
