type Logger = (message: string) => void;

type ConnectBrowserFn = (options: { browserWSEndpoint: string }) => Promise<any>;
type AttachTraceFn = (page: any, label?: string) => void;
type LoginFn = (page: any) => Promise<boolean>;
type BlockSlotFn = (page: any, entry: Record<string, any>) => Promise<{ ok?: boolean; applied?: boolean; reason?: string } | boolean>;
type UnblockSlotFn = (page: any, entry: Record<string, any>) => Promise<boolean>;
type VerifyBlockFreshFn = (browser: any, entry: Record<string, any>, options?: Record<string, any>) => Promise<boolean>;
type JournalAttemptFn = (entry: Record<string, any>, status: string, reason: string, options?: Record<string, any>) => Promise<any>;
type RecordKioskBlockAttemptFn = (...args: any[]) => Promise<any>;
type PublishRetryableFn = (entry: Record<string, any>, reason: string, options?: Record<string, any>) => Promise<any> | any;
type PublishSuccessFn = (message: string) => Promise<any> | any;
type PublishAlertFn = (payload: Record<string, any>) => Promise<any> | any;
type BuildOpsAlertMessageFn = (options: Record<string, any>) => string;
type GetKioskBlockFn = (...args: any[]) => Promise<any>;
type UpsertKioskBlockFn = (...args: any[]) => Promise<any>;
type NowKstFn = () => string;

export type CreateKioskSlotRunnerServiceDeps = {
  connectBrowser: ConnectBrowserFn;
  attachNaverScheduleTrace: AttachTraceFn;
  naverBookingLogin: LoginFn;
  blockNaverSlot: BlockSlotFn;
  unblockNaverSlot: UnblockSlotFn;
  verifyBlockStateInFreshPage: VerifyBlockFreshFn;
  journalBlockAttempt: JournalAttemptFn;
  recordKioskBlockAttempt: RecordKioskBlockAttemptFn;
  publishRetryableBlockAlert: PublishRetryableFn;
  publishKioskSuccessReport: PublishSuccessFn;
  publishReservationAlert: PublishAlertFn;
  buildOpsAlertMessage: BuildOpsAlertMessageFn;
  getKioskBlock: GetKioskBlockFn;
  upsertKioskBlock: UpsertKioskBlockFn;
  nowKST: NowKstFn;
  log: Logger;
};

export function createKioskSlotRunnerService(deps: CreateKioskSlotRunnerServiceDeps) {
  const {
    connectBrowser,
    attachNaverScheduleTrace,
    naverBookingLogin,
    blockNaverSlot,
    unblockNaverSlot,
    verifyBlockStateInFreshPage,
    journalBlockAttempt,
    recordKioskBlockAttempt,
    publishRetryableBlockAlert,
    publishKioskSuccessReport,
    publishReservationAlert,
    buildOpsAlertMessage,
    getKioskBlock,
    upsertKioskBlock,
    nowKST,
    log,
  } = deps;

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
      // ignore shim failures; callers will surface the real browser error
    }
  }

  async function runBlockSlotOnly({
    entry,
    wsEndpoint,
  }: {
    entry: Record<string, any>;
    wsEndpoint?: string | null;
  }): Promise<number> {
    const { date, start, end, room, name = '고객', phoneRaw = '00000000000' } = entry;
    log(`\n🔒 [block-slot 모드] 네이버 차단: ${name} ${date} ${start}~${end} ${room}`);

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 수동 차단 필요');
      await journalBlockAttempt(entry, 'deferred', 'naver_monitor_unavailable', {
        recordKioskBlockAttempt,
        naverBlocked: false,
        incrementRetry: true,
      });
      await Promise.resolve(publishRetryableBlockAlert(entry, 'naver-monitor 미실행', {
        prefix: '🟠',
        title: '[대리등록] 네이버 예약불가 처리 지연',
        roomSuffix: '룸',
        sourceLabel: '대리등록',
      }));
      return 1;
    }

    let naverBrowser: any = null;
    let naverPg: any = null;
    let exitCode = 1;
    try {
      naverBrowser = await connectBrowser({ browserWSEndpoint: wsEndpoint });
      log('✅ CDP 연결 성공');

      const createPage = async () => {
        const pg = await naverBrowser.newPage();
        pg.setDefaultTimeout(30000);
        await pg.setViewport({ width: 1920, height: 1080 });
        await installBrowserEvalShim(pg);
        attachNaverScheduleTrace(pg, 'block-slot');
        return pg;
      };

      naverPg = await createPage();
      const loggedIn = await naverBookingLogin(naverPg);
      if (!loggedIn) {
        log('❌ 네이버 booking 로그인 실패');
        await journalBlockAttempt(entry, 'deferred', 'naver_login_failed', {
          recordKioskBlockAttempt,
          naverBlocked: false,
          incrementRetry: true,
        });
        await Promise.resolve(publishRetryableBlockAlert(entry, '네이버 로그인 실패', {
          prefix: '🟠',
          title: '[대리등록] 네이버 예약불가 처리 지연',
          roomSuffix: '룸',
          sourceLabel: '대리등록',
        }));
        return exitCode;
      }

      let blocked = false;
      let blockResult: any = { ok: false, applied: false, reason: 'not_started' };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          blockResult = await blockNaverSlot(naverPg, entry);
          blocked = Boolean((blockResult as any)?.ok ?? blockResult);
          break;
        } catch (error: any) {
          if (String(error?.message || '').includes('detached Frame') && attempt === 1) {
            log('⚠️ Frame detach 감지 — 새 탭으로 재시도');
            try { await naverPg.close(); } catch {}
            naverPg = await createPage();
            const reLoggedIn = await naverBookingLogin(naverPg);
            if (!reLoggedIn) break;
          } else {
            log(`❌ blockNaverSlot 오류: ${error?.message || String(error)}`);
            break;
          }
        }
      }

      await upsertKioskBlock(phoneRaw, date, start, {
        name, date, start, end, room, amount: 0,
        naverBlocked: blocked,
        firstSeenAt: nowKST(),
        blockedAt: blocked ? nowKST() : null,
        lastBlockAttemptAt: nowKST(),
        lastBlockResult: blocked ? 'blocked' : 'attempted',
        lastBlockReason: blockResult?.reason || 'block_attempt_finished',
      });

      if (!blocked) {
        blocked = await verifyBlockStateInFreshPage(naverBrowser, entry, { capturePrefix: 'naver-recheck' });
        log(`  🔁 대리등록 후 독립 재검증: ${blocked ? '✅ 차단 확인' : '❌ 차단 미확인'}`);
        if (blocked) {
          const existing = await getKioskBlock(phoneRaw, date, start, end, room);
          await upsertKioskBlock(phoneRaw, date, start, {
            ...(existing || {}),
            name,
            date,
            start,
            end,
            room,
            amount: 0,
            naverBlocked: true,
            firstSeenAt: existing?.firstSeenAt || nowKST(),
            blockedAt: existing?.blockedAt || nowKST(),
            lastBlockAttemptAt: nowKST(),
            lastBlockResult: 'blocked',
            lastBlockReason: 'fresh_page_verified',
            blockRetryCount: existing?.blockRetryCount || 0,
          });
        }
      }

      if (blocked) {
        log(`✅ 네이버 차단 완료: ${name} ${date} ${start}~${end} ${room}`);
        await Promise.resolve(publishKioskSuccessReport(`✅ [대리등록] 네이버 예약불가 처리 완료\n${name} ${date} ${start}~${end} ${room}룸`));
      } else if (blockResult?.applied) {
        log('⚠️ 네이버 차단 검증 불확실 — 화면 확인 권장');
        await journalBlockAttempt(entry, 'uncertain', blockResult?.reason || 'applied_but_unverified', {
          recordKioskBlockAttempt,
          naverBlocked: false,
        });
        await Promise.resolve(publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 2,
          message: `⚠️ [대리등록] 네이버 차단 검증 불확실 — 화면 확인 권장\n${name} ${date} ${start}~${end} ${room}룸`,
        }));
        blocked = true;
      } else {
        log('⚠️ 네이버 차단 미확인 — 자동 재시도 예정');
        await journalBlockAttempt(entry, 'retryable_failure', blockResult?.reason || 'verify_failed', {
          recordKioskBlockAttempt,
          naverBlocked: false,
          incrementRetry: true,
        });
        await Promise.resolve(publishRetryableBlockAlert(entry, '차단 검증 실패', {
          prefix: '🟠',
          title: '[대리등록] 네이버 예약불가 처리 지연',
          roomSuffix: '룸',
          sourceLabel: '대리등록',
        }));
      }

      exitCode = blocked ? 0 : 1;
      return exitCode;
    } finally {
      if (naverPg) {
        try { await naverPg.close(); } catch {}
      }
      if (naverBrowser) {
        try { naverBrowser.disconnect(); } catch {}
      }
    }
  }

  async function runUnblockSlotOnly({
    entry,
    wsEndpoint,
  }: {
    entry: Record<string, any>;
    wsEndpoint?: string | null;
  }): Promise<number> {
    const { date, start, end, room, name = '고객', phoneRaw = '00000000000' } = entry;
    log(`\n🔓 [unblock-slot 모드] 네이버 차단 해제: ${name} ${date} ${start}~${end} ${room}`);

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 수동 해제 필요');
      await Promise.resolve(publishReservationAlert({
        from_bot: 'jimmy',
        event_type: 'alert',
        alert_level: 3,
        message: buildOpsAlertMessage({
          title: '⚠️ [취소] 네이버 해제 실패 — 수동 처리 필요',
          customer: name,
          date,
          start,
          end,
          room,
          status: '취소 후 복구',
          reason: 'naver-monitor 미실행',
          action: '네이버 예약가능 상태를 수동으로 복구해 주세요.',
        }),
      }));
      return 1;
    }

    let naverBrowser: any = null;
    let naverPg: any = null;
    let exitCode = 1;
    try {
      naverBrowser = await connectBrowser({ browserWSEndpoint: wsEndpoint });
      log('✅ CDP 연결 성공');

      const createPage = async () => {
        const pg = await naverBrowser.newPage();
        pg.setDefaultTimeout(30000);
        await pg.setViewport({ width: 1920, height: 1080 });
        await installBrowserEvalShim(pg);
        attachNaverScheduleTrace(pg, 'unblock-slot');
        return pg;
      };

      naverPg = await createPage();
      const loggedIn = await naverBookingLogin(naverPg);
      if (!loggedIn) {
        log('❌ 네이버 booking 로그인 실패');
        await Promise.resolve(publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: buildOpsAlertMessage({
            title: '⚠️ [취소] 네이버 해제 실패 — 수동 처리 필요',
            customer: name,
            date,
            start,
            end,
            room,
            status: '취소 후 복구',
            reason: '네이버 로그인 실패',
            action: '네이버 예약가능 상태를 수동으로 복구해 주세요.',
          }),
        }));
        return exitCode;
      }

      let unblocked = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          unblocked = await unblockNaverSlot(naverPg, entry);
          break;
        } catch (error: any) {
          if (String(error?.message || '').includes('detached Frame') && attempt === 1) {
            log('⚠️ Frame detach 감지 — 새 탭으로 재시도');
            try { await naverPg.close(); } catch {}
            naverPg = await createPage();
            const reLoggedIn = await naverBookingLogin(naverPg);
            if (!reLoggedIn) break;
          } else {
            log(`❌ unblockNaverSlot 오류: ${error?.message || String(error)}`);
            break;
          }
        }
      }

      const existing = await getKioskBlock(phoneRaw, date, start, end, room);
      await upsertKioskBlock(phoneRaw, date, start, {
        ...(existing || {}),
        name,
        date,
        start,
        end,
        room,
        naverBlocked: unblocked ? false : Boolean(existing?.naverBlocked),
        naverUnblockedAt: unblocked ? nowKST() : (existing?.naverUnblockedAt || null),
      });

      if (unblocked) {
        log(`✅ 네이버 해제 완료: ${name} ${date} ${start}~${end} ${room}`);
        await Promise.resolve(publishKioskSuccessReport(`✅ [취소] 네이버 예약가능 복구 완료\n${name} ${date} ${start}~${end} ${room}룸`));
      } else {
        log('⚠️ 네이버 해제 실패 — 수동 확인 필요');
        await Promise.resolve(publishReservationAlert({
          from_bot: 'jimmy',
          event_type: 'alert',
          alert_level: 3,
          message: buildOpsAlertMessage({
            title: '⚠️ [취소] 네이버 예약가능 복구 실패 — 수동 확인 필요',
            customer: name,
            date,
            start,
            end,
            room,
            status: '취소 후 복구',
            reason: '자동 해제 실패',
            action: '네이버 예약가능 상태를 수동으로 확인해 주세요.',
          }),
        }));
      }

      exitCode = unblocked ? 0 : 1;
      return exitCode;
    } finally {
      if (naverPg) {
        try { await naverPg.close(); } catch {}
      }
      if (naverBrowser) {
        try { naverBrowser.disconnect(); } catch {}
      }
    }
  }

  return {
    runBlockSlotOnly,
    runUnblockSlotOnly,
  };
}
