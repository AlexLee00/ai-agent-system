type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;

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
  delay: DelayFn;
  blockNaverSlot: (page: any, entry: Record<string, any>) => Promise<any>;
  unblockNaverSlot: (page: any, entry: Record<string, any>) => Promise<boolean>;
  publishKioskSuccessReport: (message: string) => void;
  getKioskBlock: (phoneRaw: string, date: string, start: string, end?: string, room?: string) => Promise<any>;
  bookingUrl: string;
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
    delay,
    blockNaverSlot,
    unblockNaverSlot,
    publishKioskSuccessReport,
    getKioskBlock,
    bookingUrl,
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
    for (const entry of toBlockEntries) {
      await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
        ...entry,
        naverBlocked: false,
        firstSeenAt: nowKST(),
        lastBlockAttemptAt: nowKST(),
        lastBlockResult: 'deferred',
        lastBlockReason: reason,
      });
      await journalBlockAttempt(entry, 'deferred', reason, {
        naverBlocked: false,
        incrementRetry: true,
      });
      publishRetryableBlockAlert(entry, reasonLabel, {
        title: '네이버 차단 지연',
        sourceLabel: '키오스크 예약',
      });
    }

    for (const entry of cancelledEntries) {
      publishReservationAlert({
        from_bot: 'jimmy',
        event_type: 'alert',
        alert_level: 3,
        message: buildOpsAlertMessage({
          title: '⚠️ 네이버 차단 해제 필요 — 수동 처리',
          customer: entry.name || '(이름없음)',
          phone: fmtPhone(entry.phoneRaw),
          date: entry.date,
          start: entry.start,
          end: entry.end,
          room: entry.room || '',
          status: '키오스크 취소',
          reason: reasonLabel,
          action: '네이버 예약가능 상태를 수동으로 복구해 주세요.',
        }),
      });
    }
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
      naverBrowser = await connectBrowser({ browserWSEndpoint: wsEndpoint });
      log('✅ CDP 연결 성공');

      const createNaverPage = async () => {
        const page = await naverBrowser.newPage();
        page.setDefaultTimeout(30000);
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

      for (const entry of toBlockEntries) {
        const key = `${entry.phoneRaw}|${entry.date}|${entry.start}`;
        log(`\n처리 중: ${key}`);

        const nowKst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const nowDateStr = `${nowKst.getFullYear()}-${String(nowKst.getMonth() + 1).padStart(2, '0')}-${String(nowKst.getDate()).padStart(2, '0')}`;
        const nowMin = nowKst.getHours() * 60 + nowKst.getMinutes();
        const [endHour, endMinute] = (entry.end || '23:59').split(':').map(Number);
        const isTimeElapsed =
          entry.date < nowDateStr ||
          (entry.date === nowDateStr && nowMin >= endHour * 60 + endMinute);

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
            event_type: 'alert',
            alert_level: 2,
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
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const blockResult = await blockNaverSlot(naverPage, entry);
            blocked = Boolean(blockResult?.ok);
            blockReason = blockResult?.reason || (blocked ? 'verified' : 'verify_failed');
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
        await upsertKioskBlock(entry.phoneRaw, entry.date, entry.start, {
          name: entry.name,
          date: entry.date,
          start: entry.start,
          end: entry.end,
          room: entry.room,
          amount: entry.amount,
          naverBlocked: blocked,
          firstSeenAt: now,
          blockedAt: blocked ? now : null,
          lastBlockAttemptAt: now,
          lastBlockResult: blocked ? 'blocked' : 'retryable_failure',
          lastBlockReason: blockReason,
        });

        if (blocked) {
          publishKioskSuccessReport(
            `✅ 네이버 예약 차단 완료\n${entry.name || '(이름없음)'} ${fmtPhone(entry.phoneRaw)}\n${entry.date} ${entry.start}~${entry.end} ${entry.room || ''} (키오스크 예약)`,
          );
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

      if (cancelledEntries.length > 0) {
        log(`\n[Phase 3B] 취소 예약 ${cancelledEntries.length}건 네이버 차단 해제 시작`);
        for (const entry of cancelledEntries) {
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
