type Logger = (message: string) => void;

type LaunchBrowserFn = (options: Record<string, any>) => Promise<any>;
type ConnectBrowserFn = (options: { browserWSEndpoint: string; protocolTimeout?: number }) => Promise<any>;
type DelayFn = (ms: number) => Promise<void>;
type PickkoLoginFn = (page: any, id: string, pw: string, delay: DelayFn) => Promise<void>;
type FetchPickkoEntriesFn = (page: any, date: string, options?: Record<string, any>) => Promise<{ entries: any[] }>;
type AttachTraceFn = (page: any, label?: string) => void;
type LoginFn = (page: any) => Promise<boolean>;
type SelectBookingDateFn = (page: any, date: string) => Promise<boolean>;
type VerifyBlockFn = (page: any, room: string, start: string, end: string) => Promise<boolean>;
type BlockSlotFn = (page: any, entry: Record<string, any>) => Promise<{ ok?: boolean } | boolean>;
type UnblockSlotFn = (page: any, entry: Record<string, any>) => Promise<boolean>;
type SetupDialogHandlerFn = (page: any, log: Logger) => void;
type PublishAlertFn = (payload: Record<string, any>) => Promise<any> | any;
type GetKioskBlockFn = (...args: any[]) => Promise<any>;
type UpsertKioskBlockFn = (...args: any[]) => Promise<any>;
type GetKioskBlocksForDateFn = (date: string) => Promise<any[]>;
type MaskNameFn = (name: string) => string;
type GetTodayKstFn = () => string;
type NowKstFn = () => string;
type GetPickkoLaunchOptionsFn = () => Record<string, any>;
type IsProtocolTimeoutErrorFn = (error: unknown) => boolean;

export type CreateKioskAuditServiceDeps = {
  launchBrowser: LaunchBrowserFn;
  connectBrowser: ConnectBrowserFn;
  delay: DelayFn;
  setupDialogHandler: SetupDialogHandlerFn;
  loginToPickko: PickkoLoginFn;
  fetchPickkoEntries: FetchPickkoEntriesFn;
  attachNaverScheduleTrace: AttachTraceFn;
  naverBookingLogin: LoginFn;
  selectBookingDate: SelectBookingDateFn;
  verifyBlockInGrid: VerifyBlockFn;
  blockNaverSlot: BlockSlotFn;
  unblockNaverSlot: UnblockSlotFn;
  publishReservationAlert: PublishAlertFn;
  getKioskBlock: GetKioskBlockFn;
  upsertKioskBlock: UpsertKioskBlockFn;
  getKioskBlocksForDate: GetKioskBlocksForDateFn;
  maskName: MaskNameFn;
  getTodayKST: GetTodayKstFn;
  nowKST: NowKstFn;
  getPickkoLaunchOptions: GetPickkoLaunchOptionsFn;
  browserProtocolTimeoutMs?: number;
  isProtocolTimeoutError?: IsProtocolTimeoutErrorFn;
  pickkoId: string;
  pickkoPw: string;
  bookingUrl: string;
  log: Logger;
};

export function createKioskAuditService(deps: CreateKioskAuditServiceDeps) {
  const {
    launchBrowser,
    connectBrowser,
    delay,
    setupDialogHandler,
    loginToPickko,
    fetchPickkoEntries,
    attachNaverScheduleTrace,
    naverBookingLogin,
    selectBookingDate,
    verifyBlockInGrid,
    blockNaverSlot,
    unblockNaverSlot,
    publishReservationAlert,
    getKioskBlock,
    upsertKioskBlock,
    getKioskBlocksForDate,
    maskName,
    getTodayKST,
    nowKST,
    getPickkoLaunchOptions,
    browserProtocolTimeoutMs = 300000,
    isProtocolTimeoutError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('Runtime.callFunctionOn timed out')
        || message.includes('ProtocolError')
        || message.includes('Target closed')
        || message.includes('Session closed')
        || message.toLowerCase().includes('timed out');
    },
    pickkoId,
    pickkoPw,
    bookingUrl,
    log,
  } = deps;

  async function auditToday({
    dateOverride = null,
    wsEndpoint,
  }: {
    dateOverride?: string | null;
    wsEndpoint?: string | null;
  }): Promise<void> {
    const today = dateOverride || getTodayKST();
    log(`\n📋 [오늘 예약 검증] ${today} 시작`);

    let pickkoEntries: any[] = [];
    let browser: any;
    try {
      browser = await launchBrowser(getPickkoLaunchOptions());
      const pages = await browser.pages();
      const page = pages[0] || await browser.newPage();
      page.setDefaultTimeout(30000);
      setupDialogHandler(page, log);
      await loginToPickko(page, pickkoId, pickkoPw, delay);
      const result = await fetchPickkoEntries(page, today, { minAmount: 1 });
      pickkoEntries = result.entries;
      log(`  픽코 예약: ${pickkoEntries.length}건`);
      for (const entry of pickkoEntries) {
        log(`    • ${maskName(entry.name)} ${entry.date} ${entry.start}~${entry.end} ${entry.room}`);
      }
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 미실행 — 검증 불가');
      await Promise.resolve(publishReservationAlert({
        from_bot: 'jimmy',
        event_type: 'alert',
        alert_level: 3,
        message: '⚠️ [오늘 예약 검증] naver-monitor 미실행으로 검증 불가',
      }));
      return;
    }

    let naverBrowser: any = null;
    let naverPg: any = null;
    const okList: any[] = [];
    const blockedList: any[] = [];
    const unblockedList: any[] = [];
    const failedList: any[] = [];

    try {
      naverBrowser = await connectBrowser({
        browserWSEndpoint: wsEndpoint,
        protocolTimeout: browserProtocolTimeoutMs,
      });
      log('✅ CDP 연결 성공');

      const createPage = async () => {
        const pg = await naverBrowser.newPage();
        pg.setDefaultTimeout(60000);
        pg.setDefaultNavigationTimeout(60000);
        await pg.setViewport({ width: 1920, height: 1080 });
        attachNaverScheduleTrace(pg, 'verify-slot');
        return pg;
      };

      const openAuditPage = async () => {
        const pg = await createPage();
        const loggedIn = await naverBookingLogin(pg);
        if (!loggedIn) {
          try { await pg.close(); } catch {}
          return null;
        }

        await pg.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await pg.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
        await delay(2000);
        return pg;
      };

      const selectAuditDateWithRecovery = async (pg: any, date: string) => {
        try {
          await selectBookingDate(pg, date);
          await delay(1000);
          return pg;
        } catch (error) {
          if (!isProtocolTimeoutError(error)) throw error;

          const message = error instanceof Error ? error.message : String(error);
          log(`⚠️ 날짜 선택 protocol timeout 감지 — 새 탭으로 1회 재시도 (${message})`);
          try { await pg.close(); } catch {}

          const recovered = await openAuditPage();
          if (!recovered) {
            throw new Error('날짜 선택 재시도 전 네이버 로그인 재확인 실패');
          }

          await selectBookingDate(recovered, date);
          await delay(1000);
          return recovered;
        }
      };

      const reopenAuditPageForRecovery = async (date: string) => {
        const recovered = await openAuditPage();
        if (!recovered) {
          throw new Error('복구용 감사 페이지 재오픈 실패');
        }
        return selectAuditDateWithRecovery(recovered, date);
      };

      const verifyBlockWithRecovery = async (pg: any, entry: any) => {
        try {
          const verified = await verifyBlockInGrid(pg, entry.room, entry.start, entry.end);
          return { page: pg, verified };
        } catch (error) {
          if (!isProtocolTimeoutError(error)) throw error;

          const message = error instanceof Error ? error.message : String(error);
          log(`  ⚠️ 차단 검증 protocol timeout 감지 — 새 탭으로 1회 재시도 (${entry.room} ${entry.start}~${entry.end}) (${message})`);
          try { await pg.close(); } catch {}

          const recovered = await reopenAuditPageForRecovery(today);
          const verified = await verifyBlockInGrid(recovered, entry.room, entry.start, entry.end);
          return { page: recovered, verified };
        }
      };

      naverPg = await openAuditPage();
      if (!naverPg) {
        log('❌ 네이버 로그인 실패');
        await Promise.resolve(publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: '⚠️ [오늘 예약 검증] 네이버 로그인 실패',
        }));
        return;
      }

      naverPg = await selectAuditDateWithRecovery(naverPg, today);

      log('\n[검증] 픽코 예약 → 네이버 차단 상태 확인');
      for (const entry of pickkoEntries) {
        try {
          const verification = await verifyBlockWithRecovery(naverPg, entry);
          naverPg = verification.page;
          const isBlocked = verification.verified;
          if (isBlocked) {
            log(`  ✅ 차단확인: ${entry.room} ${entry.start}~${entry.end} (${maskName(entry.name)})`);
            okList.push(entry);
            const existing = await getKioskBlock(entry.phoneRaw, entry.date, entry.start, entry.end, entry.room);
            if (!existing || !existing.naverBlocked) {
              await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
                ...(existing || {}),
                ...entry,
                naverBlocked: true,
                firstSeenAt: existing?.firstSeenAt || nowKST(),
                blockedAt: existing?.blockedAt || nowKST(),
              });
            }
          } else {
            log(`  ⚠️ 차단 누락: ${entry.room} ${entry.start}~${entry.end} → 차단 시도`);
            let success = false;
            for (let attempt = 1; attempt <= 2; attempt += 1) {
              try {
                const blockResult = await blockNaverSlot(naverPg, entry);
                success = typeof blockResult === 'boolean' ? blockResult : Boolean(blockResult?.ok);
                break;
              } catch (error: any) {
                if (String(error?.message || '').includes('detached Frame') && attempt === 1) {
                  log('  ⚠️ Frame detach → 새 탭으로 재시도');
                  try { await naverPg.close(); } catch {}
                  naverPg = await createPage();
                  const reLoggedIn = await naverBookingLogin(naverPg);
                  if (!reLoggedIn) break;
                } else {
                  log(`  ❌ blockNaverSlot 오류: ${error?.message || String(error)}`);
                  break;
                }
              }
            }

            const existing = await getKioskBlock(entry.phoneRaw, entry.date, entry.start, entry.end, entry.room);
            await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
              ...(existing || {}),
              ...entry,
              naverBlocked: success,
              firstSeenAt: existing?.firstSeenAt || nowKST(),
              blockedAt: success ? nowKST() : null,
            });
            if (success) blockedList.push(entry);
            else {
              log(`  ❌ 차단 실패: ${entry.room} ${entry.start}~${entry.end} — 수동 차단 필요`);
              failedList.push(entry);
            }
          }
        } catch (error: any) {
          log(`  ❌ 검증 오류 (${entry.room} ${entry.start}): ${error?.message || String(error)}`);
          failedList.push(entry);
        }
      }

      const dbBlocks = await getKioskBlocksForDate(today);
      const pickkoSet = new Set(pickkoEntries.map((entry) => `${entry.phoneRaw}|${entry.start}`));
      const orphans = dbBlocks.filter((row) => !pickkoSet.has(`${row.phoneRaw}|${row.start}`));
      log(`\n[검증] DB 차단 항목: ${dbBlocks.length}건, 고아 항목: ${orphans.length}건`);

      for (const row of orphans) {
        log(`  🗑 고아 차단 해제: ${row.room} ${row.start}~${row.end}`);
        let unblocked = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            unblocked = await unblockNaverSlot(naverPg, row);
            break;
          } catch (error: any) {
            if (String(error?.message || '').includes('detached Frame') && attempt === 1) {
              log('  ⚠️ Frame detach → 새 탭으로 재시도');
              try { await naverPg.close(); } catch {}
              naverPg = await createPage();
              const reLoggedIn = await naverBookingLogin(naverPg);
              if (!reLoggedIn) break;
            } else {
              log(`  ❌ unblockNaverSlot 오류: ${error?.message || String(error)}`);
              break;
            }
          }
        }

        if (unblocked) {
          const existing = await getKioskBlock(row.phoneRaw, row.date, row.start, row.end, row.room);
          await upsertKioskBlock(row.phoneRaw, row.date, row.start, {
            ...(existing || {}),
            ...row,
            naverBlocked: false,
            naverUnblockedAt: nowKST(),
          });
          unblockedList.push(row);
        }
      }
    } finally {
      if (naverPg) {
        try { await naverPg.close(); } catch {}
      }
      if (naverBrowser) {
        try { naverBrowser.disconnect(); } catch {}
      }
    }

    const msgParts = [`📋 [오늘 예약 검증] ${today} 완료`];
    msgParts.push(`✅ 차단확인: ${okList.length}건`);
    if (blockedList.length > 0) {
      msgParts.push(`🔒 차단추가: ${blockedList.length}건`);
      for (const entry of blockedList) msgParts.push(`  - ${entry.room} ${entry.start}~${entry.end} (${maskName(entry.name)})`);
    }
    if (unblockedList.length > 0) {
      msgParts.push(`🔓 차단해제: ${unblockedList.length}건`);
      for (const entry of unblockedList) msgParts.push(`  - ${entry.room} ${entry.start}~${entry.end}`);
    }
    if (failedList.length > 0) {
      msgParts.push(`❌ 차단실패(수동필요): ${failedList.length}건`);
      for (const entry of failedList) msgParts.push(`  - ${entry.room} ${entry.start}~${entry.end} (${maskName(entry.name)})`);
    }
    if (blockedList.length === 0 && unblockedList.length === 0 && okList.length === 0) {
      msgParts.push('오늘 예약 없음');
    } else if (blockedList.length === 0 && unblockedList.length === 0) {
      msgParts.push('이상 없음');
    }
    await Promise.resolve(publishReservationAlert({
      from_bot: 'jimmy',
      event_type: 'report',
      alert_level: 1,
      message: msgParts.join('\n'),
    }));
    log(`\n✅ 오늘 예약 검증 완료 — 확인: ${okList.length}, 차단추가: ${blockedList.length}, 해제: ${unblockedList.length}, 실패: ${failedList.length}`);
  }

  return {
    auditToday,
  };
}
