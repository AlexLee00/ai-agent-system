type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type GetKioskBlockFn = (phoneRaw: string, date: string, start: string, end?: string, room?: string) => Promise<any>;
type CompareEntrySequenceFn = (a: Record<string, any>, b: Record<string, any>) => number;
const {
  splitKioskEntryForNaverBlocks,
} = require('./kiosk-monitor-helpers');
const { isValidSourceEntry } = require('./reservation-source-classifier');
type KioskEntry = Record<string, any> & {
  phoneRaw: string;
  date: string;
  start: string;
  end?: string;
  room?: string;
  key?: string;
};

export type CreateKioskPickkoCycleServiceDeps = {
  log: Logger;
  delay: DelayFn;
  loginToPickko: (page: any, id: string, pw: string, delay: DelayFn) => Promise<any>;
  fetchPickkoEntries: (page: any, today: string, options?: Record<string, any>) => Promise<{ entries: Record<string, any>[]; fetchOk?: boolean }>;
  getKioskBlock: GetKioskBlockFn;
  compareEntrySequence: CompareEntrySequenceFn;
  maskName: (name: string) => string;
  maskPhone: (phone: string) => string;
  persistPickkoLiveSnapshot?: (payload: Record<string, any>) => any;
};

export function createKioskPickkoCycleService(deps: CreateKioskPickkoCycleServiceDeps) {
  const {
    log,
    delay,
    loginToPickko,
    fetchPickkoEntries,
    maskName,
    maskPhone,
    persistPickkoLiveSnapshot,
  } = deps;

  const SOURCE_SCAN_DAYS_AHEAD = Number(process.env.KIOSK_SOURCE_SCAN_DAYS_AHEAD || 31);
  const PICKKO_RANGE_PAGE_LIMIT_THRESHOLD = Number(process.env.PICKKO_RANGE_PAGE_LIMIT_THRESHOLD || 20);
  const PICKKO_RECEIPT_FAST_SCAN_ENABLED = process.env.KIOSK_PICKKO_RECEIPT_FAST_SCAN_ENABLED !== '0';
  const PICKKO_PAID_DATE_FALLBACK_ENABLED = process.env.KIOSK_PICKKO_PAID_DATE_FALLBACK_ENABLED === '1';

  function addDaysKST(dateStr: string, days: number): string {
    const date = new Date(`${dateStr}T00:00:00+09:00`);
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  function dedupeEntries(entries: Record<string, any>[]): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}|${entry.statusText || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }

  function normalizeSourceEntries(entries: Record<string, any>[]): Record<string, any>[] {
    return entries
      .flatMap((entry) => splitKioskEntryForNaverBlocks(entry))
      .filter(isValidSourceEntry);
  }

  function isPaidEntry(entry: Record<string, any>): boolean {
    return String(entry?.statusText || '').includes('결제완료');
  }

  async function fetchReceiptFastScanPaidEntries(page: any, today: string) {
    if (!PICKKO_RECEIPT_FAST_SCAN_ENABLED) {
      return { entries: [], fetchOk: true, skipped: true };
    }

    log(`\n[Pickko fast-scan] 접수일시 최신순 fast-scan: 접수일 ${today}, 상태=전체보기`);
    let result: { entries: Record<string, any>[]; fetchOk?: boolean };
    try {
      result = await fetchPickkoEntries(page, today, {
        sortBy: 'sd_regdate',
        receiptDate: today,
        statusKeyword: '',
        minAmount: 0,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[Pickko fast-scan] 실패 — 기존 결제완료 날짜별 fallback으로 전환: ${message}`);
      return { entries: [], fetchOk: false, skipped: false };
    }
    const entries = normalizeSourceEntries(result.entries)
      .filter(isPaidEntry);

    log(`[Pickko fast-scan] 당일 접수 결제완료 후보 ${entries.length}건 (fetchOk=${result.fetchOk ?? true})`);
    for (const entry of entries) {
      log(`  • ${maskName(entry.name)} ${maskPhone(entry.phoneRaw)} | ${entry.date} ${entry.start}~${entry.end} | ${entry.room} | 접수 ${entry.receiptText || '-'}`);
    }

    return { entries, fetchOk: result.fetchOk ?? true, skipped: false };
  }

  async function fetchTodayPaidEntries(page: any, today: string) {
    log(`\n[Pickko 조회] 이용일 ${today}, 상태=결제완료, 이용금액 필터 없음`);
    const result = await fetchPickkoEntries(page, today, {
      endDate: today,
      statusKeyword: '결제완료',
      minAmount: 0,
    });
    const entries = normalizeSourceEntries(result.entries)
      .filter((entry) => entry.date === today)
      .filter(isPaidEntry);

    log(`[Pickko 조회] 오늘 이용 결제완료 후보 ${entries.length}건 (fetchOk=${result.fetchOk ?? true})`);
    return { entries, fetchOk: result.fetchOk ?? true };
  }

  async function fetchSourceEntries({
    page,
    today,
    endDate,
    statusKeyword,
    seedEntries = [],
    useDateFallback = true,
  }: {
    page: any;
    today: string;
    endDate: string;
    statusKeyword: string;
    seedEntries?: Record<string, any>[];
    useDateFallback?: boolean;
  }) {
    const rangeResult = await fetchPickkoEntries(page, today, {
      endDate,
      statusKeyword,
      minAmount: 0,
    });
    const rangeEntries = normalizeSourceEntries(rangeResult.entries);
    const combinedRangeEntries = dedupeEntries([...seedEntries, ...rangeEntries]);

    if (rangeEntries.length < PICKKO_RANGE_PAGE_LIMIT_THRESHOLD || endDate === today) {
      return { entries: combinedRangeEntries, fetchOk: rangeResult.fetchOk ?? true, usedDateFallback: false };
    }

    log(`[Pickko 조회] ${statusKeyword} 범위 조회 ${rangeEntries.length}건 — 페이지 한계 가능성으로 날짜 단위 재조회`);
    if (!useDateFallback) {
      log(`[Pickko 조회] ${statusKeyword} 날짜 단위 재조회 생략 — 접수일시 최신순 fast-scan 결과와 범위 첫 페이지를 우선 사용`);
      return {
        entries: combinedRangeEntries,
        fetchOk: rangeResult.fetchOk ?? true,
        usedDateFallback: false,
        skippedDateFallback: true,
      };
    }

    const byDateEntries: Record<string, any>[] = [];
    let fetchOk = rangeResult.fetchOk ?? true;
    for (let offset = 0; offset <= SOURCE_SCAN_DAYS_AHEAD; offset += 1) {
      const date = addDaysKST(today, offset);
      const dayResult = await fetchPickkoEntries(page, date, {
        endDate: date,
        statusKeyword,
        minAmount: 0,
      });
      fetchOk = fetchOk && (dayResult.fetchOk ?? true);
      byDateEntries.push(
        ...normalizeSourceEntries(dayResult.entries),
      );
    }
    return { entries: dedupeEntries([...seedEntries, ...byDateEntries]), fetchOk, usedDateFallback: true };
  }

  async function preparePickkoCycle({
    page,
    today,
    pickkoId,
    pickkoPw,
  }: {
    page: any;
    today: string;
    pickkoId: string;
    pickkoPw: string;
  }) {
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, pickkoId, pickkoPw, delay);
    log(`✅ 픽코 로그인 완료: ${page.url()}`);

    const endDate = addDaysKST(today, SOURCE_SCAN_DAYS_AHEAD);
    const receiptFastScanResult = await fetchReceiptFastScanPaidEntries(page, today);
    const todayPaidResult = await fetchTodayPaidEntries(page, today);
    log(`\n[Pickko 조회] 이용일 ${today}~${endDate}, 상태=결제완료, 이용금액 필터 없음`);
    const paidResult = await fetchSourceEntries({
      page,
      today,
      endDate,
      statusKeyword: '결제완료',
      seedEntries: [...receiptFastScanResult.entries, ...todayPaidResult.entries],
      useDateFallback: PICKKO_PAID_DATE_FALLBACK_ENABLED || receiptFastScanResult.skipped || !receiptFastScanResult.fetchOk,
    });
    const paidFetchOk = (receiptFastScanResult.fetchOk ?? true)
      && (todayPaidResult.fetchOk ?? true)
      && (paidResult.fetchOk ?? true);
    const kioskEntries = paidResult.entries;

    if (persistPickkoLiveSnapshot) {
      try {
        const snapshotResult = await Promise.resolve(persistPickkoLiveSnapshot({
          collectedAt: new Date().toISOString(),
          coverageFrom: today,
          coverageTo: endDate,
          complete: (paidResult.fetchOk ?? true) && paidResult.skippedDateFallback !== true,
          fetchOk: paidResult.fetchOk ?? true,
          entries: kioskEntries,
        }));
        log(`[Pickko snapshot] ${snapshotResult?.trustedUpdated ? 'trusted 갱신' : 'partial 시도 기록'} (${kioskEntries.length}건)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[Pickko snapshot] 기록 실패 — 모니터 계속 진행: ${message}`);
      }
    }

    for (const entry of kioskEntries) {
      log(`  • ${maskName(entry.name)} ${maskPhone(entry.phoneRaw)} | ${entry.date} ${entry.start}~${entry.end} | ${entry.room} | ${entry.amount}원`);
    }

    const newEntries = kioskEntries;
    const retryEntries: Record<string, any>[] = [];
    const toBlockEntries = kioskEntries;

    log('\n[Phase 2B] 픽코 취소/환불 예약 직접 조회');
    log(`[Pickko 조회] 이용일 ${today}~${endDate}, 상태=환불, 이용금액 필터 없음`);
    const refundedResult = await fetchSourceEntries({
      page,
      today,
      endDate,
      statusKeyword: '환불',
    });
    const refundedEntries = refundedResult.entries;
    log(`[Pickko 조회] 이용일 ${today}~${endDate}, 상태=취소, 이용금액 필터 없음`);
    const cancelledStatusResult = await fetchSourceEntries({
      page,
      today,
      endDate,
      statusKeyword: '취소',
    });
    const cancelledStatusEntries = cancelledStatusResult.entries;

    const rawCancelledEntries = [...refundedEntries, ...cancelledStatusEntries];
    const dedupedCancelledEntries: Record<string, any>[] = [];
    const seenCancelledKeys = new Set<string>();
    for (const entry of rawCancelledEntries) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`;
      if (seenCancelledKeys.has(key)) continue;
      seenCancelledKeys.add(key);
      dedupedCancelledEntries.push(entry);
    }

    const cancelledWithKey = dedupedCancelledEntries.map((entry) => ({
      ...(entry as KioskEntry),
      key: `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`,
    })) as KioskEntry[];
    const cancelledEntries = cancelledWithKey;

    log(`\n📦 Pickko 결제완료 원천 후보: ${kioskEntries.length}건 (금액 0 포함, 네이버 원천 분류 전)`);
    log(`🗑 Pickko 취소/환불 원천 후보: 환불 ${refundedEntries.length}건 / 취소 ${cancelledStatusEntries.length}건 / 합산 ${dedupedCancelledEntries.length}건 (네이버 원천 분류 전)`);

    return {
      fetchOk: paidFetchOk,
      kioskEntries,
      newEntries,
      retryEntries,
      toBlockEntries,
      excludedEntries: [],
      refundedEntries,
      cancelledStatusEntries,
      dedupedCancelledEntries,
      cancelledEntries,
    };
  }

  return {
    preparePickkoCycle,
  };
}
