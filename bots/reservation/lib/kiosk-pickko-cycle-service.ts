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
};

export function createKioskPickkoCycleService(deps: CreateKioskPickkoCycleServiceDeps) {
  const {
    log,
    delay,
    loginToPickko,
    fetchPickkoEntries,
    maskName,
    maskPhone,
  } = deps;

  const SOURCE_SCAN_DAYS_AHEAD = Number(process.env.KIOSK_SOURCE_SCAN_DAYS_AHEAD || 31);
  const PICKKO_RANGE_PAGE_LIMIT_THRESHOLD = Number(process.env.PICKKO_RANGE_PAGE_LIMIT_THRESHOLD || 20);

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

  async function fetchSourceEntries({
    page,
    today,
    endDate,
    statusKeyword,
  }: {
    page: any;
    today: string;
    endDate: string;
    statusKeyword: string;
  }) {
    const rangeResult = await fetchPickkoEntries(page, today, {
      endDate,
      statusKeyword,
      minAmount: 0,
    });
    const rangeEntries = rangeResult.entries
      .flatMap((entry) => splitKioskEntryForNaverBlocks(entry))
      .filter(isValidSourceEntry);

    if (rangeEntries.length < PICKKO_RANGE_PAGE_LIMIT_THRESHOLD || endDate === today) {
      return { entries: rangeEntries, fetchOk: rangeResult.fetchOk ?? true, usedDateFallback: false };
    }

    log(`[Pickko 조회] ${statusKeyword} 범위 조회 ${rangeEntries.length}건 — 페이지 한계 가능성으로 날짜 단위 재조회`);
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
        ...dayResult.entries
          .flatMap((entry) => splitKioskEntryForNaverBlocks(entry))
          .filter(isValidSourceEntry),
      );
    }
    return { entries: dedupeEntries(byDateEntries), fetchOk, usedDateFallback: true };
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
    log(`\n[Pickko 조회] 이용일 ${today}~${endDate}, 상태=결제완료, 이용금액 필터 없음`);
    const paidResult = await fetchSourceEntries({
      page,
      today,
      endDate,
      statusKeyword: '결제완료',
    });
    const kioskEntries = paidResult.entries;

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
      fetchOk: paidResult.fetchOk ?? true,
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
