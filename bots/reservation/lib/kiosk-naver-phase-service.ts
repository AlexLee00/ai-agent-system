type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
const {
  getKioskNaverBlockEntry,
  isKioskEntryEnded,
  normalizeKioskSlotEndTime,
} = require('./kiosk-monitor-helpers');
const {
  classifyPickkoEntriesByNaver,
  isValidSourceEntry,
  normalizeSourceRoom,
} = require('./reservation-source-classifier');

const TIME_ELAPSED_DEDUPE_MINUTES = 12 * 60;

export type CreateKioskNaverPhaseServiceDeps = {
  log: Logger;
  readWsFile: (path: string, encoding: BufferEncoding) => string;
  connectBrowser: (options: Record<string, any>) => Promise<any>;
  attachNaverScheduleTrace: (page: any, label?: string) => void;
  naverBookingLogin: (page: any) => Promise<boolean>;
  upsertKioskBlock: (phoneRaw: string, date: string, start: string, patch: Record<string, any>) => Promise<any>;
  journalBlockAttempt: (entry: Record<string, any>, result: string, reason: string, options?: Record<string, any>) => Promise<any>;
  publishRetryableBlockAlert: (entry: Record<string, any>, reason: string, options?: Record<string, any>) => void;
  publishReservationAlert: (payload: Record<string, any>) => void;
  buildOpsAlertMessage: (options: Record<string, any>) => string;
  fmtPhone: (phone: string) => string;
  nowKST: () => string;
  waitForCustomerCooldown: (
    entry: Record<string, any>,
    tracker: Map<string, any>,
    actionLabel: string,
    cooldownMs: number,
    delay: DelayFn,
    log: Logger,
  ) => Promise<void>;
  markCustomerCooldown: (entry: Record<string, any>, tracker: Map<string, any>) => void;
  runtimeConfig: { customerOperationCooldownMs?: number | string };
  browserProtocolTimeoutMs?: number;
  delay: DelayFn;
  blockNaverSlot: (page: any, entry: Record<string, any>) => Promise<any>;
  unblockNaverSlot: (page: any, entry: Record<string, any>) => Promise<boolean>;
  publishKioskSuccessReport: (message: string) => void;
  getKioskBlock: (phoneRaw: string, date: string, start: string, end?: string, room?: string) => Promise<any>;
  bookingUrl: string;
  scrapeNewestBookingsFromList?: (page: any, limit?: number) => Promise<Record<string, any>[]>;
  sourceClassificationDaysAhead?: number;
  sourceSnapshotLimit?: number;
};

export function createKioskNaverPhaseService(deps: CreateKioskNaverPhaseServiceDeps) {
  const {
    log,
    readWsFile,
    connectBrowser,
    attachNaverScheduleTrace,
    naverBookingLogin,
    upsertKioskBlock,
    journalBlockAttempt,
    publishRetryableBlockAlert,
    publishReservationAlert,
    buildOpsAlertMessage,
    fmtPhone,
    nowKST,
    waitForCustomerCooldown,
    markCustomerCooldown,
    runtimeConfig,
    browserProtocolTimeoutMs = 300000,
    delay,
    blockNaverSlot,
    unblockNaverSlot,
    publishKioskSuccessReport,
    getKioskBlock,
    bookingUrl,
    scrapeNewestBookingsFromList,
    sourceClassificationDaysAhead = 31,
    sourceSnapshotLimit = 300,
  } = deps;

  function normalizeIncidentPart(value: unknown): string {
    return String(value || 'unknown')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'unknown';
  }

  function buildTimeElapsedIncidentKey(entry: Record<string, any>): string {
    const phoneDigits = String(entry?.phoneRaw || '').replace(/\D/g, '');
    const phoneSuffix = phoneDigits ? phoneDigits.slice(-4) : 'unknown';
    const slot = `${entry?.start || 'unknown'}-${entry?.end || 'unknown'}`.replace(/:/g, '');
    return [
      'reservation',
      'jimmy',
      'naver_block_time_elapsed',
      normalizeIncidentPart(entry?.date),
      normalizeIncidentPart(entry?.room),
      normalizeIncidentPart(slot),
      normalizeIncidentPart(phoneSuffix),
    ].join(':');
  }

  function addDaysKST(dateStr: string, days: number): string {
    const date = new Date(`${dateStr}T00:00:00+09:00`);
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  function todayKST(): string {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  }

  function buildConfirmedUseDateRangeUrl(startDate: string, endDate: string): string {
    const url = new URL(bookingUrl);
    url.pathname = url.pathname.replace(/booking-calendar-view.*$/, 'booking-list-view');
    if (!url.pathname.includes('booking-list-view')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/booking-list-view`;
    }
    url.search = '';
    url.searchParams.set('bookingStatusCodes', 'RC03');
    url.searchParams.set('dateDropdownType', 'RANGE');
    url.searchParams.set('dateFilter', 'USEDATE');
    url.searchParams.set('startDateTime', startDate);
    url.searchParams.set('endDateTime', endDate);
    return url.toString();
  }

  function sortEntries(entries: Record<string, any>[]): Record<string, any>[] {
    return [...entries].sort((a, b) => {
      const left = `${a.date || ''}|${a.start || ''}|${a.room || ''}|${a.phoneRaw || ''}`;
      const right = `${b.date || ''}|${b.start || ''}|${b.room || ''}|${b.phoneRaw || ''}`;
      return left.localeCompare(right);
    });
  }

  function dedupeEntries(entries: Record<string, any>[]): Record<string, any>[] {
    const out: Record<string, any>[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }

  function getSavedKioskBlockForSourceEntry(entry: Record<string, any>) {
    return getKioskBlock(
      entry.phoneRaw,
      entry.date,
      entry.start,
      normalizeKioskSlotEndTime(entry.end),
      normalizeSourceRoom(entry.room),
    );
  }

  async function loadNaverConfirmedUseDateSnapshot(page: any): Promise<{
    rows: Record<string, any>[];
    startDate: string;
    endDate: string;
    url: string;
  }> {
    if (typeof scrapeNewestBookingsFromList !== 'function') {
      throw new Error('scrapeNewestBookingsFromList dependency is required for source classification');
    }
    const startDate = todayKST();
    const endDate = addDaysKST(startDate, sourceClassificationDaysAhead);
    const url = buildConfirmedUseDateRangeUrl(startDate, endDate);
    log(`🔎 [원천분류] 네이버 확정 USEDATE 조회: ${startDate}~${endDate}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(1200);
    const rows = await scrapeNewestBookingsFromList(page, sourceSnapshotLimit);
    log(`🔎 [원천분류] 네이버 확정 snapshot: ${rows.length}건`);
    return { rows, startDate, endDate, url };
  }

  async function installBrowserEvalShim(page: any) {
    try {
      await page.evaluateOnNewDocument(() => {
        const shim = (value: any) => value;
        (globalThis as any).__name = shim;
        (window as any).__name = shim;
        try {
          (0, eval)('var __name = globalThis.__name;');
        } catch {
          // ignore binding fallback
        }
      });
      await page.evaluate(() => {
        const shim = (value: any) => value;
        (globalThis as any).__name = shim;
        (window as any).__name = shim;
        try {
          (0, eval)('var __name = globalThis.__name;');
        } catch {
          // ignore binding fallback
        }
      }).catch(() => null);
    } catch {
      // ignore shim failures; downstream browser actions will surface real errors
    }
  }

  async function deferEntriesForUnavailable({
    toBlockEntries,
    cancelledEntries,
    reason,
  }: {
    toBlockEntries: Record<string, any>[];
    cancelledEntries: Record<string, any>[];
    reason: 'naver_monitor_unavailable' | 'naver_login_failed';
  }) {
    const reasonLabel = reason === 'naver_login_failed' ? '네이버 로그인 실패' : 'naver-monitor 미실행';
    log(`🛡️ [원천분류] ${reasonLabel} — Pickko 후보 ${toBlockEntries.length}건/취소후보 ${cancelledEntries.length}건 자동 처리 중단`);
    publishReservationAlert({
      from_bot: 'jimmy',
      event_type: 'alert',
      alert_level: 3,
      message: buildOpsAlertMessage({
        title: '⚠️ 네이버 원천 분류 불가 — 자동 처리 중단',
        status: 'Pickko 후보 미분류',
        reason: `${reasonLabel}. 네이버 live 확정 목록 없이 예약불가/해제를 실행하지 않음`,
        action: 'naver-monitor 로그인/WS 상태를 복구한 뒤 다음 사이클에서 재분류',
      }),
    });
  }

  async function processNaverPhase({
    wsFile,
    toBlockEntries,
    cancelledEntries,
    recordKioskBlockAttempt,
  }: {
    wsFile: string;
    toBlockEntries: Record<string, any>[];
    cancelledEntries: Record<string, any>[];
    recordKioskBlockAttempt: (...args: any[]) => Promise<any>;
  }) {
    let wsEndpoint: string | null = null;
    try { wsEndpoint = readWsFile(wsFile, 'utf8').trim(); } catch (_) {}

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 브라우저 미실행 (WS 파일 없음). 수동 처리 필요.');
      await deferEntriesForUnavailable({
        toBlockEntries,
        cancelledEntries,
        reason: 'naver_monitor_unavailable',
      });
      return;
    }

    log(`📡 CDP 연결: ${wsEndpoint.slice(0, 60)}...`);

    let naverBrowser: any = null;
    let naverPage: any = null;

    try {
      naverBrowser = await connectBrowser({
        browserWSEndpoint: wsEndpoint,
        protocolTimeout: browserProtocolTimeoutMs,
      });
      log('✅ CDP 연결 성공');

      const createNaverPage = async () => {
        const page = await naverBrowser.newPage();
        page.setDefaultTimeout(60000);
        page.setDefaultNavigationTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });
        await installBrowserEvalShim(page);
        attachNaverScheduleTrace(page, 'main-loop');
        return page;
      };

      naverPage = await createNaverPage();
      log('  → 새 탭 오픈 (1920×1080)');

      const loggedIn = await naverBookingLogin(naverPage);
      if (!loggedIn) {
        log('❌ 네이버 booking 로그인 실패');
        await deferEntriesForUnavailable({
          toBlockEntries,
          cancelledEntries,
          reason: 'naver_login_failed',
        });
        return;
      }

      const customerOperationTracker = new Map<string, any>();
      let confirmedSnapshot: { rows: Record<string, any>[]; startDate: string; endDate: string; url: string };
      try {
        confirmedSnapshot = await loadNaverConfirmedUseDateSnapshot(naverPage);
      } catch (error: any) {
        const message = error?.message || String(error);
        log(`🛡️ [원천분류] 네이버 확정 snapshot 실패 — 자동 처리 중단: ${message}`);
        publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: buildOpsAlertMessage({
            title: '⚠️ 네이버 확정 snapshot 실패 — 자동 처리 중단',
            status: 'Pickko 후보 미분류',
            reason: message,
            action: '네이버 USEDATE 확정 목록 파싱 복구 후 재시도',
          }),
        });
        return;
      }
      if (confirmedSnapshot.rows.length === 0 && (toBlockEntries.length > 0 || cancelledEntries.length > 0)) {
        log('🛡️ [원천분류] 네이버 확정 snapshot 0건 — Pickko 후보가 있어 자동 처리 중단');
        publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: buildOpsAlertMessage({
            title: '⚠️ 네이버 확정 snapshot 0건 — 자동 처리 중단',
            status: 'Pickko 후보 미분류',
            reason: '네이버 확정 목록 파싱 결과가 0건이므로 DOM 변경/필터 오류 가능성이 있음',
            action: '네이버 확정 목록 live 파싱을 확인한 뒤 예약불가/해제를 재시도',
          }),
        });
        return;
      }
      const invalidConfirmedRows = confirmedSnapshot.rows.filter((entry) => !isValidSourceEntry(entry));
      if (invalidConfirmedRows.length > 0 && (toBlockEntries.length > 0 || cancelledEntries.length > 0)) {
        log(`🛡️ [원천분류] 네이버 확정 snapshot 불완전 ${invalidConfirmedRows.length}건 — 자동 처리 중단`);
        publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: buildOpsAlertMessage({
            title: '⚠️ 네이버 확정 snapshot 불완전 — 자동 처리 중단',
            status: 'Pickko 후보 미분류',
            reason: '네이버 확정 목록에 전화/date/room/time 중 누락된 row가 있어 원천 분류가 불완전함',
            action: '네이버 확정 목록 DOM 파싱을 확인한 뒤 예약불가/해제를 재시도',
          }),
        });
        return;
      }

      const blockSource = classifyPickkoEntriesByNaver(toBlockEntries, confirmedSnapshot.rows);
      const cancelSource = classifyPickkoEntriesByNaver(cancelledEntries, confirmedSnapshot.rows);
      log(
        `[원천분류] 차단 후보 ${toBlockEntries.length}건 → 네이버 매칭 제외 ${blockSource.naverMatched.length}건 / ` +
        `키오스크·수동 ${blockSource.kioskOrManual.length}건 / invalid ${blockSource.invalid.length}건`,
      );
      log(
        `[원천분류] 취소/환불 후보 ${cancelledEntries.length}건 → 네이버 매칭 제외 ${cancelSource.naverMatched.length}건 / ` +
        `키오스크·수동 ${cancelSource.kioskOrManual.length}건 / invalid ${cancelSource.invalid.length}건`,
      );

      const sourceBlockCandidates = sortEntries(dedupeEntries(blockSource.kioskOrManual));
      const sourceCancelCandidates = sortEntries(dedupeEntries(cancelSource.kioskOrManual));
      const blockSaved = await Promise.all(
        sourceBlockCandidates.map((entry) => getSavedKioskBlockForSourceEntry(entry)),
      );
      const newEntries = sourceBlockCandidates.filter((_, index) => !blockSaved[index]);
      const nowForRetry = new Date();
      const retryEntries = sourceBlockCandidates.filter((entry, index) => {
        const saved = blockSaved[index];
        if (!saved) return false;
        if (saved.naverBlocked) return false;
        if (saved.naverUnblockedAt) return false;
        return !isKioskEntryEnded(entry, nowForRetry);
      });
      const blockEntries = sortEntries(dedupeEntries([...newEntries, ...retryEntries]));

      const cancelSaved = await Promise.all(
        sourceCancelCandidates.map((entry) => getSavedKioskBlockForSourceEntry(entry)),
      );
      const unblockEntries = sortEntries(sourceCancelCandidates.filter((entry, index) => {
        const saved = cancelSaved[index];
        if (!saved || !saved.naverBlocked) return false;
        if (saved.naverUnblockedAt) return false;
        return true;
      }));
      log(`[원천분류] 처리 대상 확정: 신규 ${newEntries.length}건 / 재시도 ${retryEntries.length}건 / 차단 ${blockEntries.length}건 / 해제 ${unblockEntries.length}건`);

      for (const entry of blockEntries) {
        const key = `${entry.phoneRaw}|${entry.date}|${entry.start}`;
        log(`\n처리 중: ${key}`);

        const isTimeElapsed = isKioskEntryEnded(entry);

        if (isTimeElapsed) {
          log(`  ⏰ [시간 경과] 네이버 차단 생략: ${entry.date} ${entry.end} 이미 종료됨`);
          const now = nowKST();
          await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
            name: entry.name,
            date: entry.date,
            start: entry.start,
            end: entry.end,
            room: entry.room,
            amount: entry.amount,
            naverBlocked: false,
            firstSeenAt: now,
            blockedAt: null,
            lastBlockAttemptAt: now,
            lastBlockResult: 'skipped',
            lastBlockReason: 'time_elapsed',
          });
          publishReservationAlert({
            from_bot: 'jimmy',
            event_type: 'report',
            alert_level: 1,
            incident_key: buildTimeElapsedIncidentKey(entry),
            dedupe_minutes: TIME_ELAPSED_DEDUPE_MINUTES,
            message: buildOpsAlertMessage({
              title: '⏰ 시간 경과 — 네이버 차단 생략',
              customer: entry.name || '(이름없음)',
              phone: fmtPhone(entry.phoneRaw),
              date: entry.date,
              start: entry.start,
              end: entry.end,
              room: entry.room || '',
              status: '키오스크 예약',
              reason: '예약 종료 시각이 지나 네이버 차단이 불필요함',
              action: '픽코 등록 상태만 확인해 주세요.',
            }),
          });
          continue;
        }

        await waitForCustomerCooldown(
          entry,
          customerOperationTracker,
          '예약 차단',
          Number(runtimeConfig.customerOperationCooldownMs || 0),
          delay,
          log,
        );

        let blocked = false;
        let blockReason = 'verify_failed';
        const naverBlockEntry = getKioskNaverBlockEntry(entry);
        if (!naverBlockEntry) {
          const now = nowKST();
          log(`  ⏰ [부분 시간 경과] 네이버에서 열 수 있는 미래 슬롯 없음: ${entry.date} ${entry.start}~${entry.end}`);
          await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
            name: entry.name,
            date: entry.date,
            start: entry.start,
            end: entry.end,
            room: entry.room,
            amount: entry.amount,
            naverBlocked: false,
            firstSeenAt: now,
            blockedAt: null,
            lastBlockAttemptAt: now,
            lastBlockResult: 'skipped',
            lastBlockReason: 'time_elapsed_no_blockable_slot',
          });
          continue;
        }
        if (naverBlockEntry.naverBlockAdjustedStart && naverBlockEntry.naverBlockAdjustedStart !== entry.start) {
          log(`  ⏩ 진행 중 예약 — 지난 슬롯 제외: ${entry.start} → ${naverBlockEntry.start} (종료 ${entry.end})`);
        }
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const blockResult = await blockNaverSlot(naverPage, naverBlockEntry);
            blocked = Boolean(blockResult?.ok);
            blockReason = blockResult?.reason || (blocked ? 'verified' : 'verify_failed');
            if (blocked && naverBlockEntry.naverBlockAdjustedStart && naverBlockEntry.naverBlockAdjustedStart !== entry.start) {
              blockReason = `${blockReason}_partial_from_${naverBlockEntry.naverBlockAdjustedStart.replace(':', '')}`;
            }
            if (!blocked && blockReason === 'exception' && attempt === 1) {
              log(`⚠️ 네이버 차단 예외 — 새 탭으로 재시도 (attempt ${attempt + 1}/2, error=${blockResult?.error || 'unknown'})`);
              try { await naverPage.close(); } catch (_) {}
              naverPage = await createNaverPage();
              const reloggedIn = await naverBookingLogin(naverPage);
              if (!reloggedIn) {
                blocked = false;
                blockReason = 'naver_relogin_failed';
                break;
              }
              continue;
            }
            if (!blocked && attempt === 1) {
              log(`⚠️ 네이버 차단 검증 실패 — 예약불가 처리 1회 재실행 (attempt ${attempt + 1}/2, reason=${blockReason})`);
              await new Promise((resolve) => setTimeout(resolve, 1500));
              continue;
            }
            break;
          } catch (err: any) {
            if (String(err.message || '').includes('detached Frame') && attempt === 1) {
              log(`⚠️ Frame detach 감지 — 새 탭으로 재시도 (attempt ${attempt + 1}/2)`);
              try { await naverPage.close(); } catch (_) {}
              naverPage = await createNaverPage();
              const reloggedIn = await naverBookingLogin(naverPage);
              if (!reloggedIn) {
                blocked = false;
                blockReason = 'naver_relogin_failed';
                break;
              }
            } else {
              log(`❌ blockNaverSlot 오류: ${err.message}`);
              const screenshotPath = `/tmp/naver-block-${entry.date}-fatal.png`;
              await naverPage.screenshot({ path: screenshotPath }).catch(() => null);
              blockReason = 'exception';
              break;
            }
          }
        }
        markCustomerCooldown(entry, customerOperationTracker);

        const now = nowKST();
        const existingAfterAttempt = await getSavedKioskBlockForSourceEntry(entry);
        const preserveBlockedState = existingAfterAttempt?.naverBlocked === true && !blocked;
        await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
          name: entry.name,
          date: entry.date,
          start: entry.start,
          end: entry.end,
          room: entry.room,
          amount: entry.amount,
          naverBlocked: blocked || preserveBlockedState,
          firstSeenAt: now,
          blockedAt: blocked ? now : (preserveBlockedState ? existingAfterAttempt?.blockedAt || now : null),
          lastBlockAttemptAt: now,
          lastBlockResult: blocked ? 'blocked' : (preserveBlockedState ? existingAfterAttempt?.lastBlockResult || 'blocked' : 'retryable_failure'),
          lastBlockReason: blocked ? blockReason : (preserveBlockedState ? existingAfterAttempt?.lastBlockReason || 'preserved_existing_block' : blockReason),
        });

        if (blocked) {
          publishKioskSuccessReport(
            `✅ 네이버 예약 차단 완료\n${entry.name || '(이름없음)'} ${fmtPhone(entry.phoneRaw)}\n${entry.date} ${entry.start}~${entry.end} ${entry.room || ''} (키오스크 예약)`,
          );
        } else if (preserveBlockedState) {
          log(`  ℹ️ 기존 네이버 차단 상태 보존: ${entry.date} ${entry.start}~${entry.end} ${entry.room || ''} (reason=${blockReason})`);
        } else {
          await journalBlockAttempt(entry, 'retryable_failure', blockReason, {
            recordKioskBlockAttempt,
            naverBlocked: false,
            incrementRetry: true,
          });
          publishRetryableBlockAlert(entry, `차단 실패(${blockReason})`, {
            title: '네이버 차단 미확인',
            sourceLabel: '키오스크 예약',
          });
        }
      }

      if (unblockEntries.length > 0) {
        log(`\n[Phase 3B] 취소 예약 ${unblockEntries.length}건 네이버 차단 해제 시작`);
        for (const entry of unblockEntries) {
          log(`\n처리 중 (취소): ${entry.key}`);

          await waitForCustomerCooldown(
            entry,
            customerOperationTracker,
            '예약 해제',
            Number(runtimeConfig.customerOperationCooldownMs || 0),
            delay,
            log,
          );

          let unblocked = false;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              unblocked = await unblockNaverSlot(naverPage, entry);
              break;
            } catch (err: any) {
              if (String(err.message || '').includes('detached Frame') && attempt === 1) {
                log(`⚠️ Frame detach 감지 — 새 탭으로 재시도 (attempt ${attempt + 1}/2)`);
                try { await naverPage.close(); } catch (_) {}
                naverPage = await createNaverPage();
                const reLoggedIn = await naverBookingLogin(naverPage);
                if (!reLoggedIn) {
                  unblocked = false;
                  break;
                }
              } else {
                log(`❌ unblockNaverSlot 오류: ${err.message}`);
                const screenshotPath = `/tmp/naver-unblock-${entry.date}-fatal.png`;
                await naverPage.screenshot({ path: screenshotPath }).catch(() => null);
                break;
              }
            }
          }
          markCustomerCooldown(entry, customerOperationTracker);

          if (unblocked) {
            const existing = await getKioskBlock(entry.phoneRaw, entry.date, entry.start, entry.end, entry.room);
            await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
              ...(existing || {}),
              ...entry,
              naverBlocked: false,
              naverUnblockedAt: nowKST(),
            });
            publishKioskSuccessReport(
              `✅ 네이버 예약불가 해제\n${entry.name || '(이름없음)'} ${fmtPhone(entry.phoneRaw)}\n${entry.date} ${entry.start}~${entry.end} ${entry.room || ''} (키오스크 취소)`,
            );
          } else {
            publishReservationAlert({
              from_bot: 'jimmy',
              event_type: 'alert',
              alert_level: 3,
              message: buildOpsAlertMessage({
                title: '⚠️ 네이버 차단 해제 실패 — 수동 처리 필요',
                customer: entry.name || '(이름없음)',
                phone: fmtPhone(entry.phoneRaw),
                date: entry.date,
                start: entry.start,
                end: entry.end,
                room: entry.room || '',
                status: '키오스크 취소',
                reason: '자동 해제 실패',
                action: '네이버 예약가능 상태를 수동으로 복구해 주세요.',
              }),
            });
          }
        }
      }
    } finally {
      if (naverPage) {
        try { await naverPage.close(); } catch (_) {}
      }
      if (naverBrowser) {
        try { naverBrowser.disconnect(); } catch (_) {}
      }
    }
  }

  return {
    processNaverPhase,
  };
}
