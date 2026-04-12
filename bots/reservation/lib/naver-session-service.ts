type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type PublishAlertFn = (payload: Record<string, any>) => Promise<any> | any;
type GetSecretFn = (key: string, fallback?: string) => string;
type IsHeadedModeFn = (channel?: string) => boolean;
type EnsureHeadedFlagFn = (reason?: string) => void;

export type CreateNaverSessionServiceDeps = {
  delay: DelayFn;
  log: Logger;
  publishReservationAlert: PublishAlertFn;
  getSecret: GetSecretFn;
  isHeadedMode: IsHeadedModeFn;
  ensureHeadedFlag: EnsureHeadedFlagFn;
  naverUrl: string;
};

export function createNaverSessionService(deps: CreateNaverSessionServiceDeps) {
  const {
    delay,
    log,
    publishReservationAlert,
    getSecret,
    isHeadedMode,
    ensureHeadedFlag,
    naverUrl,
  } = deps;

  async function closePopupsIfPresent(page: any): Promise<void> {
    try {
      if (!page || page.isClosed?.() === true) return;

      let popupCount = 0;
      const maxLoops = 10;
      for (let loop = 0; loop < maxLoops; loop += 1) {
        try {
          const popupHandled = await page.evaluate(() => {
            let handled = false;
            const checkbox = document.querySelector('input#checkShow') as HTMLInputElement | null;
            if (checkbox && !checkbox.checked && checkbox.offsetParent !== null) {
              checkbox.click();
              handled = true;
            }

            const closeBtn =
              document.querySelector('button.Popup_btn_close__YO5i8') ||
              document.querySelector('button[data-testid="popup-close-btn"]');
            if (closeBtn && (closeBtn as HTMLElement).offsetParent !== null) {
              (closeBtn as HTMLElement).click();
              handled = true;
            }
            return handled;
          }).catch(() => false);

          if (popupHandled) {
            popupCount += 1;
            log(`✅ 팝업 #${popupCount} 처리 완료 (일주일동안보지않기 + X 클릭)`);
            await delay(800);
          } else {
            if (loop > 0) log(`✅ 모든 팝업 처리 완료 (총 ${popupCount}개)`);
            else log('ℹ️ 팝업 없음 - 계속 진행');
            break;
          }
        } catch (error: any) {
          if (!String(error?.message || error).includes('detached')) {
            log(`⚠️ 팝업 감지 중 에러(무시): ${error?.message || String(error)}`);
          }
          break;
        }
      }
    } catch (error: any) {
      log(`⚠️ 팝업 처리 실패: ${error?.message || String(error)}`);
    }
  }

  async function ensureHomeFromCalendar(page: any): Promise<void> {
    try {
      const url = page.url();
      const isSubPage = [
        'booking-list-view',
        'booking-calendar-view',
        'booking-order-view',
        'booking-detail',
      ].some((keyword) => url.includes(keyword));

      if (!isSubPage && url.startsWith(naverUrl)) return;

      log(`↩️ 홈 URL로 복귀 (현재: ${url})`);
      await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => null);
    } catch (error: any) {
      log(`⚠️ 홈 URL 복귀 실패(무시): ${error?.message || String(error)}`);
    }
  }

  async function naverLogin(page: any): Promise<boolean> {
    const MAX_RETRY = 3;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
      try {
        if (attempt > 1) {
          log(`🔄 로그인 재시도 ${attempt}/${MAX_RETRY} (3초 대기)...`);
          await delay(3000);
        }
        log('🔐 네이버 로그인 시작...');

        await page.goto(naverUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);

        const homeReady = await page.evaluate(() => {
          const text = (document.body && (document.body.innerText || document.body.textContent)) || '';
          return text.includes('오늘 확정') || text.includes('예약 현황');
        });
        if (homeReady) {
          log('✅ 이미 로그인 상태(홈 예약현황 감지)');
          return true;
        }

        log('🔍 팝업 확인 중...');
        const popupBtnCoords = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
            const text = (btn.textContent || '').trim();
            if (
              btn instanceof HTMLElement &&
              btn.offsetParent !== null &&
              ['확인', 'OK', '닫기', '완료', '네', 'Yes'].includes(text)
            ) {
              const rect = btn.getBoundingClientRect();
              return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text };
            }
          }
          return null;
        });

        if (popupBtnCoords) {
          log(`🔍 팝업 버튼 감지: "${popupBtnCoords.text}" — navigation 대기 후 클릭`);
          try {
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
              page.mouse.click(popupBtnCoords.x, popupBtnCoords.y),
            ]);
            log('✅ 팝업 클릭 및 navigation 완료');
            await delay(1500);
          } catch (error: any) {
            log(`⚠️ 팝업 클릭 중 오류(무시): ${error?.message || String(error)}`);
          }
        } else {
          log('ℹ️ 팝업 없음 - 계속 진행');
        }

        const hasLoginForm = await page.$('input#id, input[name="id"], input#pw, input[name="pw"]');
        if (hasLoginForm) {
          const headless = !isHeadedMode('naver');
          if (headless) {
            log('⚠️ 로그인 폼 감지: 현재 headless 모드입니다. 2단계 보안이 있으면 실패할 수 있어요. PLAYWRIGHT_HEADLESS=false 또는 NAVER_HEADLESS=0으로 재실행 권장');
          }

          log('로그인 필요 - 아이디/비밀번호 입력 시도');
          await page.waitForSelector('input#id, input[name="id"]', { timeout: 10000 });
          const idSel = (await page.$('input#id')) ? 'input#id' : 'input[name="id"]';
          const pwSel = (await page.$('input#pw')) ? 'input#pw' : 'input[name="pw"]';

          await page.click(idSel, { clickCount: 3 });
          await page.type(idSel, getSecret('naver_id', ''), { delay: 30 });
          await page.click(pwSel, { clickCount: 3 });
          await page.type(pwSel, getSecret('naver_pw', ''), { delay: 30 });

          const loginBtnSel = (await page.$('button#log\\.login')) ? 'button#log\\.login'
            : (await page.$('button[type="submit"]')) ? 'button[type="submit"]'
            : null;
          if (loginBtnSel) await page.click(loginBtnSel);
          else await page.keyboard.press('Enter');

          await delay(5000);
          const securityCheck = await page.evaluate(() => {
            const url = window.location.href;
            const text = document.body?.innerText || document.body?.textContent || '';
            const isNaverAuth = url.includes('nid.naver.com');
            const hasSecurityKeyword = /보안|인증|OTP|일회용|문자|전화|휴대폰|기기 등록|로그인 알림|보안문자|캡차|captcha/i.test(text);
            const alreadyDone = text.includes('오늘 확정') || text.includes('예약 현황');
            return { isNaverAuth, hasSecurityKeyword, alreadyDone, url: url.slice(0, 120) };
          }).catch(() => ({ isNaverAuth: false, hasSecurityKeyword: false, alreadyDone: false }));

          if (!securityCheck.alreadyDone && (securityCheck.isNaverAuth || securityCheck.hasSecurityKeyword)) {
            log(`🔐 보안인증 화면 감지: ${JSON.stringify(securityCheck)}`);
            ensureHeadedFlag('naver-security-auth');
            const authMsg =
              '🔐 네이버 보안인증 필요!\n\n' +
              '로그인 후 추가 인증 화면이 감지됐어요.\n' +
              '브라우저를 보이는 모드로 자동 전환했습니다.\n' +
              '맥 스튜디오에서 인증 화면을 완료해주세요.\n\n' +
              '✅ 인증 완료되면 자동으로 모니터링이 재개됩니다.\n' +
              '⏳ 최대 30분 대기 후 자동으로 재시작됩니다.';
            await Promise.resolve(publishReservationAlert({
              from_bot: 'andy',
              event_type: 'alert',
              alert_level: 4,
              message: authMsg,
            }));
          } else if (securityCheck.alreadyDone) {
            log('✅ 로그인 후 즉시 대시보드 감지 → 보안인증 불필요');
          }

          log('⏳ (필요시) IP보안/2단계 화면을 완료해주세요. 완료되면 업체 대시보드(오늘 확정)가 보입니다. 최대 30분 대기');
          await page.waitForFunction(() => {
            try {
              const buttons = Array.from(document.querySelectorAll('button'));
              for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (['확인', 'OK', 'Yes', '네'].includes(text) && btn instanceof HTMLElement && btn.offsetParent !== null) {
                  btn.click();
                  break;
                }
              }
            } catch {}
            const text = (document.body && (document.body.innerText || document.body.textContent)) || '';
            return text.includes('오늘 확정') || text.includes('예약 현황');
          }, { timeout: 30 * 60 * 1000 }).catch(() => null);

          await page.goto(naverUrl, { waitUntil: 'networkidle2' });
        } else {
          log('⚠️ 로그인 폼을 못 찾음(추가 인증/차단 가능).');
        }

        const clickMyBizIfPresent = async () => {
          const clicked = await page.evaluate(() => {
            const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
            const targetText = '커피랑도서관 분당서현점';
            const anchors = Array.from(document.querySelectorAll('a'));
            for (const anchor of anchors) {
              const text = clean(anchor.textContent);
              if (text.includes(targetText)) {
                (anchor as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (clicked) {
            log('🏪 내 업체(커피랑도서관 분당서현점) 카드 클릭');
            await page.waitForNetworkIdle({ idleTime: 800, timeout: 20000 }).catch(() => null);
          }
          return clicked;
        };

        const waitTodayCards = async (timeoutMs: number) => {
          await page.waitForFunction(() => {
            const text = (document.body && (document.body.innerText || document.body.textContent)) || '';
            return text.includes('오늘 확정') || text.includes('예약 현황');
          }, { timeout: timeoutMs });
        };

        try {
          await clickMyBizIfPresent();
          await waitTodayCards(30000);
        } catch {
          log('⏳ 추가 확인 단계/업체 선택 대기: 브라우저에서 안내대로 진행해주세요.');
          log('   완료되면 자동으로 업체 카드 클릭/오늘 확정 감지를 재시도합니다.');

          const startedAt = Date.now();
          while (Date.now() - startedAt < 10 * 60 * 1000) {
            await clickMyBizIfPresent();
            try {
              await waitTodayCards(5000);
              break;
            } catch {
              await delay(1000);
            }
          }
          await waitTodayCards(20000);
        }

        log('✅ 페이지 로드 완료(오늘 확정 카드 감지)');
        return true;
      } catch (error: any) {
        const retryable = /detached|disconnected|closed|hang up|socket/i.test(error?.message || '');
        log(`❌ 로그인/페이지 로드 실패 (시도 ${attempt}/${MAX_RETRY}): ${error?.message || String(error)}`);
        if (attempt < MAX_RETRY && retryable) continue;
        return false;
      }
    }
    return false;
  }

  return {
    closePopupsIfPresent,
    ensureHomeFromCalendar,
    naverLogin,
  };
}
