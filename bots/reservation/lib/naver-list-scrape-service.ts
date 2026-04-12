type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;

export type CreateNaverListScrapeServiceDeps = {
  delay: DelayFn;
  log: Logger;
};

export function createNaverListScrapeService(deps: CreateNaverListScrapeServiceDeps) {
  const { delay, log } = deps;

  async function scrapeExpandedCancelled(page: any, cancelHref: string): Promise<any[]> {
    await page.goto(cancelHref, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1000);

    try {
      const activeBtn = await page.$(
        'input[class*="BookingListView__active__"][value*="오늘취소"], ' +
        'input.BookingListView__active__2xtEI[value*="오늘취소"]',
      );
      if (activeBtn) {
        log('[취소감지2E] "오늘취소" 날짜 필터 비활성화');
        await activeBtn.click();
        await delay(1200);
      }
    } catch (error: any) {
      log(`[취소감지2E] Step1 실패 (무시): ${error?.message || String(error)}`);
    }

    try {
      const dateDropBtn = await page.$('[class*="Select__root"] button[class*="Select__btn-selected"]');
      if (dateDropBtn) {
        const currentText = await page.evaluate((el: any) => el.querySelector('span')?.textContent?.trim(), dateDropBtn);
        if (currentText && currentText !== '일간') {
          await dateDropBtn.click();
          await delay(500);
          const changed = await page.evaluate(() => {
            for (const el of Array.from(document.querySelectorAll('button, li, [role="option"]'))) {
              if (el.textContent?.trim() === '일간') {
                (el as HTMLElement).click();
                return true;
              }
            }
            return false;
          });
          if (changed) await delay(1000);
        }
      }
    } catch (error: any) {
      log(`[취소감지2E] Step2 실패 (무시): ${error?.message || String(error)}`);
    }

    try {
      const statusDropBtn = await page.$('#dropdownBookingStatus');
      if (statusDropBtn) {
        await statusDropBtn.click();
        await delay(500);
        const checked = await page.evaluate(() => {
          const menu = document.querySelector('[aria-labelledby="dropdownBookingStatus"], [class*="dropdown-menu"]');
          if (!menu) return false;
          for (const item of Array.from(menu.querySelectorAll('li, label, [role="option"]'))) {
            const text = item.textContent?.trim() || '';
            if (text === '취소' || (text.includes('취소') && !text.includes('노쇼') && !text.includes('이용완료'))) {
              const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
              if (checkbox && !checkbox.checked) {
                checkbox.click();
                return true;
              }
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        });
        if (checked) {
          await delay(500);
          await page.keyboard.press('Escape').catch(() => {});
          await delay(800);
          await page.evaluate(() => {
            const closeBtn = document.querySelector('[class*="drawer__close"], [class*="side-panel__close"], [aria-label="닫기"]');
            if (closeBtn) (closeBtn as HTMLElement).click();
          }).catch(() => {});
          await delay(500);
        }
      }
    } catch (error: any) {
      log(`[취소감지2E] Step3 실패 (무시): ${error?.message || String(error)}`);
    }

    return scrapeNewestBookingsFromList(page, 50);
  }

  async function scrapeNewestBookingsFromList(page: any, limit = 5): Promise<any[]> {
    await page.waitForSelector(
      'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
      { timeout: 20000 },
    );

    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('a[class*="contents-user"]');
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
      return rows.length > 0 || noData;
    }, { timeout: 20000 });

    return page.evaluate((n: number) => {
      const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
      if (noData) return [];

      const rows = Array.from(document.querySelectorAll('a[class*="contents-user"]')).slice(0, n);
      if (rows.length === 0) return [];

      const to24Start = (ampm: string, hh: string, mm: string) => {
        let hour = parseInt(hh, 10);
        const minute = String(parseInt(mm, 10)).padStart(2, '0');
        if (ampm === '오후' && hour < 12) hour += 12;
        if (ampm === '오전' && hour === 12) hour = 0;
        return `${String(hour).padStart(2, '0')}:${minute}`;
      };

      const to24End = (ampm: string, hh: string, mm: string) => {
        let hour = parseInt(hh, 10);
        const minute = String(parseInt(mm, 10)).padStart(2, '0');
        if (ampm === '오후' && hour < 12) hour += 12;
        if (ampm === '오전' && hour === 12) hour = 0;
        return `${String(hour).padStart(2, '0')}:${minute}`;
      };

      const formatPhone = (phone: string) => {
        if (!phone || phone.length !== 11) return phone;
        return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
      };

      const out: any[] = [];
      for (const row of rows) {
        const nameEl = row.querySelector('[class*="name__"]');
        const phoneEl = row.querySelector('[class*="phone__"] span');
        const bookDateEl = row.querySelector('[class*="book-date__"]');
        const hostEl = row.querySelector('[class*="host__"]');
        const bookIdEl = row.querySelector('[class*="book-number__"]');

        const name = clean(nameEl?.textContent);
        const phoneText = clean(phoneEl?.textContent);
        const phone = phoneText ? phoneText.replace(/\D/g, '') : null;
        const bookingId = clean(bookIdEl?.textContent);

        const dateTimeText = clean(bookDateEl?.textContent);
        let date: string | null = null;
        let start: string | null = null;
        let end: string | null = null;

        if (dateTimeText) {
          const dateMatch = dateTimeText.match(/(\d{2})\.\s+(\d{1,2})\.\s+(\d{1,2})/);
          if (dateMatch) {
            const yyyy = `20${dateMatch[1]}`;
            const mm = String(parseInt(dateMatch[2], 10)).padStart(2, '0');
            const dd = String(parseInt(dateMatch[3], 10)).padStart(2, '0');
            date = `${yyyy}-${mm}-${dd}`;
          }

          const timeMatch = dateTimeText.match(/(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
          if (timeMatch) {
            const startAmpm = timeMatch[1];
            const startHour = parseInt(timeMatch[2], 10);
            const startMin = parseInt(timeMatch[3], 10);
            const endHour = parseInt(timeMatch[5], 10);
            const endMin = parseInt(timeMatch[6], 10);
            let endAmpm = timeMatch[4];

            if (!endAmpm) {
              if ((endHour >= 1 && endHour <= 11) && startAmpm === '오전') {
                endAmpm = endHour < startHour ? '오후' : '오전';
              } else if (endHour === 12 && startAmpm === '오전') {
                endAmpm = '오후';
              } else if (startAmpm === '오후' && endHour >= 1 && endHour <= 11) {
                if (startHour === 12) endAmpm = '오후';
                else endAmpm = endHour < startHour ? '오전' : '오후';
              } else {
                endAmpm = startAmpm;
              }
            }

            start = to24Start(startAmpm, String(startHour), String(startMin).padStart(2, '0'));
            end = to24End(endAmpm, String(endHour), String(endMin).padStart(2, '0'));
          }
        }

        const hostText = clean(hostEl?.textContent);
        const roomMatch = hostText.match(/\b(A1|A2|B)\b/i);
        const room = roomMatch ? roomMatch[1].toUpperCase() : null;

        if (phone && start && end && date) {
          const phoneFormatted = formatPhone(phone);
          const uniqueId = `${date}|${start}|${end}|${room}|${phone}`;
          out.push({
            bookingId: bookingId || uniqueId,
            phone: phoneFormatted,
            phoneRaw: phone,
            date,
            start,
            end,
            room,
            raw: { name, dateTimeText, hostText, phoneText },
          });
        }
      }

      return out;
    }, limit);
  }

  return {
    scrapeExpandedCancelled,
    scrapeNewestBookingsFromList,
  };
}
