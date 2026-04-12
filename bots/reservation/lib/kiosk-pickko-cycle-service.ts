type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type GetKioskBlockFn = (phoneRaw: string, date: string, start: string, end?: string, room?: string) => Promise<any>;
type CompareEntrySequenceFn = (a: Record<string, any>, b: Record<string, any>) => number;
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
    getKioskBlock,
    compareEntrySequence,
    maskName,
    maskPhone,
  } = deps;

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

    log(`\n[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=결제완료`);
    const { entries: kioskEntries, fetchOk } = await fetchPickkoEntries(page, today, { minAmount: 1 });

    for (const entry of kioskEntries) {
      log(`  • ${maskName(entry.name)} ${maskPhone(entry.phoneRaw)} | ${entry.date} ${entry.start}~${entry.end} | ${entry.room} | ${entry.amount}원`);
    }

    const kioskFlags = await Promise.all(
      kioskEntries.map((entry) => getKioskBlock(entry.phoneRaw, entry.date, entry.start, entry.end, entry.room)),
    );
    const newEntries = kioskEntries.filter((_, index) => !kioskFlags[index]);

    const nowForRetry = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const nowDateForRetry = `${nowForRetry.getFullYear()}-${String(nowForRetry.getMonth() + 1).padStart(2, '0')}-${String(nowForRetry.getDate()).padStart(2, '0')}`;
    const nowMinForRetry = nowForRetry.getHours() * 60 + nowForRetry.getMinutes();
    const retryEntries = kioskEntries.filter((entry, index) => {
      const saved = kioskFlags[index];
      if (!saved) return false;
      if (saved.naverBlocked) return false;
      if (saved.naverUnblockedAt) return false;
      const [endHour, endMinute] = (entry.end || '23:59').split(':').map(Number);
      const isExpired =
        entry.date < nowDateForRetry ||
        (entry.date === nowDateForRetry && nowMinForRetry >= endHour * 60 + endMinute);
      return !isExpired;
    });

    const toBlockEntries: Record<string, any>[] = [];
    const seenBlockKeys = new Set<string>();
    for (const entry of [...newEntries, ...retryEntries]) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`;
      if (seenBlockKeys.has(key)) continue;
      seenBlockKeys.add(key);
      toBlockEntries.push(entry);
    }
    toBlockEntries.sort(compareEntrySequence);

    log('\n[Phase 2B] 픽코 취소/환불 예약 직접 조회');
    log(`[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=환불`);
    const { entries: refundedEntries } = await fetchPickkoEntries(page, today, { statusKeyword: '환불', minAmount: 1 });
    log(`[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=취소`);
    const { entries: cancelledStatusEntries } = await fetchPickkoEntries(page, today, { statusKeyword: '취소', minAmount: 1 });

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
    const cancelledSaved = await Promise.all(
      cancelledWithKey.map((entry) => getKioskBlock(entry.phoneRaw, entry.date, entry.start, entry.end, entry.room)),
    );
    const cancelledEntries = cancelledWithKey.filter((entry, index) => {
      const saved = cancelledSaved[index];
      if (!saved || !saved.naverBlocked) return false;
      if (saved.naverUnblockedAt) return false;
      return true;
    });
    cancelledEntries.sort(compareEntrySequence);

    log(`\n🆕 신규 키오스크 예약: ${newEntries.length}건 / 🔁 차단 재시도: ${retryEntries.length}건 (전체 ${kioskEntries.length}건)`);
    log(`🗑 픽코 취소 감지: 환불 ${refundedEntries.length}건 / 취소 ${cancelledStatusEntries.length}건 / 합산 ${dedupedCancelledEntries.length}건 (처리 필요: ${cancelledEntries.length}건)`);

    return {
      fetchOk: fetchOk ?? true,
      kioskEntries,
      newEntries,
      retryEntries,
      toBlockEntries,
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
