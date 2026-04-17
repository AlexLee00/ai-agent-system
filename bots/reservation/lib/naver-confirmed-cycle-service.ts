type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;
type SaveJsonFn = (path: string, data: unknown) => void;
type ScrapeNewestBookingsFromListFn = (page: any, limit?: number) => Promise<Record<string, any>[]>;
type ProcessConfirmedCandidatesFn = (args: { newest: Record<string, any>[]; page: any }) => Promise<void>;

export type CreateNaverConfirmedCycleServiceDeps = {
  delay: DelayFn;
  log: Logger;
  saveJson: SaveJsonFn;
  scrapeNewestBookingsFromList: ScrapeNewestBookingsFromListFn;
  processConfirmedCandidates: ProcessConfirmedCandidatesFn;
};

export function createNaverConfirmedCycleService(deps: CreateNaverConfirmedCycleServiceDeps) {
  const {
    delay,
    log,
    saveJson,
    scrapeNewestBookingsFromList,
    processConfirmedCandidates,
  } = deps;

  async function processConfirmedCycle({
    page,
    naverUrl,
    workspace,
  }: {
    page: any;
    naverUrl: string;
    workspace: string;
  }): Promise<{
    confirmedCount: number;
    cancelledCount: number;
    cancelledHref: string | null;
    currentConfirmedList: Record<string, any>[];
  }> {
    log('🧩 오늘 확정 리스트 파싱 시도...');

    const {
      confirmedHref: rawConfirmedHref,
      cancelledHref,
      confirmedCount,
      cancelledCount,
    } = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      let confirmed: HTMLAnchorElement | undefined;
      let cancelled: HTMLAnchorElement | undefined;
      for (const link of links) {
        const anchor = link as HTMLAnchorElement;
        const text = String(anchor.textContent || '').replace(/\s+/g, ' ').trim();
        const href = String(anchor.href || '');
        if (!confirmed && text.includes('오늘 확정') && href.includes('booking-list-view')) {
          confirmed = anchor;
        }
        if (!cancelled && text.includes('오늘 취소') && href.includes('booking-list-view')) {
          cancelled = anchor;
        }
        if (confirmed && cancelled) break;
      }
      let confirmedCountValue = 0;
      let cancelledCountValue = 0;
      if (confirmed) {
        const strong = confirmed.querySelector('strong');
        const num = parseInt(String((strong ? strong.textContent : confirmed.textContent) || '').replace(/\D/g, ''), 10);
        confirmedCountValue = Number.isNaN(num) ? 0 : num;
      }
      if (cancelled) {
        const strong = cancelled.querySelector('strong');
        const num = parseInt(String((strong ? strong.textContent : cancelled.textContent) || '').replace(/\D/g, ''), 10);
        cancelledCountValue = Number.isNaN(num) ? 0 : num;
      }
      return {
        confirmedHref: confirmed ? confirmed.href : null,
        cancelledHref: cancelled ? cancelled.href : null,
        confirmedCount: confirmedCountValue,
        cancelledCount: cancelledCountValue,
      };
    });

    log(`📊 카운터: 오늘 확정=${confirmedCount}, 오늘 취소=${cancelledCount}`);

    let confirmedHref = rawConfirmedHref;
    if (!confirmedHref) {
      const today = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })
        .replace(/\./g, '')
        .replace(/\s/g, '-')
        .split('-')
        .filter(Boolean)
        .map((value, index) => (index === 0 ? value : value.padStart(2, '0')))
        .join('-');
      const bizId = naverUrl.match(/\/place\/(\d+)/)?.[1] || naverUrl.split('/').filter(Boolean).pop();
      confirmedHref = `https://new.smartplace.naver.com/bizes/place/${bizId}/booking-list-view?status=CONFIRMED&date=${today}`;
      log(`⚠️ 오늘 확정 링크 자동 탐색 실패 → URL 직접 구성: ${confirmedHref}`);
    }

    if (confirmedCount === 0) {
      log('ℹ️ 오늘 확정 0건 → 리스트 파싱 스킵');
      return {
        confirmedCount,
        cancelledCount,
        cancelledHref,
        currentConfirmedList: [],
      };
    }

    log(`🔗 오늘 확정 리스트 이동 (${confirmedCount}건): ${confirmedHref}`);
    await page.goto(confirmedHref, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => null);
    await delay(500);

    log('🔍 5단계 팝업 확인 중...');
    try {
      const popupHandled = await page.evaluate(() => {
        let handled = false;
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
        for (const checkbox of checkboxes) {
          const label = checkbox.closest('label') || checkbox.parentElement;
          const labelText = (label?.textContent || '').trim();
          if (labelText.includes('일주일') || labelText.includes('보지않기')) {
            const isVisible = checkbox.offsetParent !== null;
            if (isVisible && !checkbox.checked) {
              checkbox.click();
              handled = true;
            }
            break;
          }
        }

        const closeButtons = Array.from(document.querySelectorAll('button, div[role="button"]')) as HTMLElement[];
        for (const button of closeButtons) {
          const text = (button.textContent || '').trim();
          const className = String(button.className || '');
          const isClose =
            button.getAttribute('aria-label')?.includes('닫기') ||
            text === '✕' ||
            text === 'X' ||
            className.includes('close') ||
            className.includes('Close');
          if (isClose && button.offsetParent !== null) {
            button.click();
            handled = true;
            break;
          }
        }

        return handled;
      }).catch(() => false);

      if (popupHandled) {
        log('✅ 5단계 팝업 처리 완료 (일주일동안보지않기 + X 클릭)');
        await delay(1000);
      } else {
        log('ℹ️ 5단계 팝업 없음 - 계속 진행');
      }
    } catch (popupErr: any) {
      log(`⚠️ 5단계 팝업 처리 중 에러: ${popupErr.message}`);
    }

    log(`🌐 현재 URL: ${page.url()}`);
    await page.waitForSelector('a[data-tst_click_link], [class*="nodata-area"], [class*="nodata"], .nodata', { timeout: 30000 });
    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('a[data-tst_click_link]');
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
      return rows.length > 0 || noData;
    }, { timeout: 30000 });
    await delay(800);

    log('🔍 렌더링 상태 점검 중...');
    const pageState = await page.evaluate(() => {
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata') as HTMLElement | null;
      const byDataAttr = document.querySelectorAll('a[data-tst_click_link]');
      const byRole = document.querySelectorAll('[role="row"], [role="listitem"]');
      const allAnchors = document.querySelectorAll('a');
      const pageText = (document.body?.innerText || '').slice(0, 500);
      return {
        noDataPresent: !!noData,
        noDataVisible: noData?.offsetParent !== null,
        dataAttrCount: byDataAttr.length,
        roleRowCount: byRole.length,
        totalAnchors: allAnchors.length,
        pageHasPhone: /010-?\d{4}-?\d{4}/.test(pageText),
        pageHasTime: /(\d{1,2}):(\d{2})/.test(pageText),
        pageHasRoom: /\b(A1|A2|B)\b/.test(pageText),
        pageTextSample: pageText,
      };
    });
    log(`🔍 페이지 상태: ${JSON.stringify(pageState)}`);

    if (pageState.noDataPresent && pageState.noDataVisible) {
      log('ℹ️ 오늘 확정 예약 없음 (nodata 영역 감지)');
    }

    const newest = await scrapeNewestBookingsFromList(page, 20);
    log(`🧾 리스트 파싱 결과(상위): ${JSON.stringify(newest.slice(0, 3))}`);

    try {
      const fullDataFile = `${workspace}/naver-bookings-full.json`;
      saveJson(fullDataFile, newest);
      log(`💾 전체 파싱 데이터 저장: ${fullDataFile} (${newest.length}건)`);
    } catch (err: any) {
      log(`⚠️ 전체 데이터 저장 실패: ${err.message}`);
    }

    if (newest.length === 0 || newest.every((booking) => !booking.phone)) {
      const debugInfo = await page.evaluate(() => {
        const allLinks = document.querySelectorAll('a[data-tst_click_link]');
        const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
        const samples = Array.from(allLinks).slice(0, 3).map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: (a.textContent || '').slice(0, 100),
          dataAttr: a.getAttribute('data-tst_click_link'),
          phone: (a.querySelector('[class*="phone"]') as HTMLElement | null)?.textContent || 'null',
          time: (a.querySelector('[class*="date"], [class*="time"]') as HTMLElement | null)?.textContent || 'null',
        }));
        return {
          totalLinks: allLinks.length,
          noDataPresent: !!noData,
          samples,
        };
      });
      log(`🔍 디버그 - 상세 분석: ${JSON.stringify(debugInfo)}`);
    }

    if (newest.length === 0) {
      const debugInfo = await page.evaluate(() => {
        const noData = !!document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
        const rowCount = document.querySelectorAll('a[data-tst_click_link]').length;
        const text = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\s+/g, ' ').trim();
        return { noData, rowCount, textHead: text.slice(0, 200) };
      });
      log(`🧪 리스트 디버그: ${JSON.stringify(debugInfo)}`);
    }

    await processConfirmedCandidates({ newest, page });

    return {
      confirmedCount,
      cancelledCount,
      cancelledHref,
      currentConfirmedList: newest,
    };
  }

  return {
    processConfirmedCycle,
  };
}
