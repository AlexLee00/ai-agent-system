type Logger = (message: string) => void;
type DelayFn = (ms: number) => Promise<void>;

export type CreateNaverListScrapeServiceDeps = {
  delay: DelayFn;
  log: Logger;
};

function todayKst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function addDaysKst(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00+09:00`);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function buildBookingStatusListUrl(sourceUrl: string, {
  statusCode,
  startDate = todayKst(),
  endDate,
  daysAhead = 30,
  dateDropdownType = 'RANGE',
  dateFilter = 'USEDATE',
}: {
  statusCode: string;
  startDate?: string;
  endDate?: string;
  daysAhead?: number;
  dateDropdownType?: string;
  dateFilter?: string;
}): string {
  if (!sourceUrl) throw new Error('sourceUrl_required');
  const url = new URL(sourceUrl);
  if (!url.pathname.includes('booking-list-view')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/booking-list-view`;
  }
  url.search = '';
  url.searchParams.set('bookingStatusCodes', statusCode);
  url.searchParams.set('dateDropdownType', dateDropdownType);
  url.searchParams.set('startDateTime', startDate);
  url.searchParams.set('endDateTime', endDate || addDaysKst(startDate, daysAhead));
  url.searchParams.set('dateFilter', dateFilter);
  url.searchParams.set('searchValueCode', 'USER_NAME');
  return url.toString();
}

export function parseNaverDateTimeText(input: unknown, fallbackDate?: string | null): { date: string; start: string; end: string } | null {
  const dateTimeText = String(input || '').replace(/\s+/g, ' ').trim();
  if (!dateTimeText) return null;

  const dateMatch = dateTimeText.match(/(\d{2})\.\s+(\d{1,2})\.\s+(\d{1,2})/);
  const timeMatch = dateTimeText.match(/(오전|오후)\s*(\d{1,2}):(\d{2})\s*~\s*(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (!dateMatch && !fallbackDate) return null;
  if (!timeMatch) return null;

  const date = dateMatch
    ? `20${dateMatch[1]}-${String(parseInt(dateMatch[2], 10)).padStart(2, '0')}-${String(parseInt(dateMatch[3], 10)).padStart(2, '0')}`
    : String(fallbackDate || '').trim();

  const startAmpm = timeMatch[1];
  const startHour = parseInt(timeMatch[2], 10);
  const startMin = parseInt(timeMatch[3], 10);
  const endHour = parseInt(timeMatch[5], 10);
  const endMin = parseInt(timeMatch[6], 10);
  let endAmpm = timeMatch[4];

  if (!endAmpm) {
    if ((endHour >= 1 && endHour <= 11) && startAmpm === '오전') {
      endAmpm = startHour === 12 || endHour >= startHour ? '오전' : '오후';
    } else if (endHour === 12 && startAmpm === '오전') {
      endAmpm = '오후';
    } else if (startAmpm === '오후' && endHour >= 1 && endHour <= 11) {
      endAmpm = startHour === 12 || endHour >= startHour ? '오후' : '오전';
    } else {
      endAmpm = startAmpm;
    }
  }

  let startHour24 = startHour;
  let endHour24 = endHour;
  if (startAmpm === '오후' && startHour24 < 12) startHour24 += 12;
  if (startAmpm === '오전' && startHour24 === 12) startHour24 = 0;
  if (endAmpm === '오후' && endHour24 < 12) endHour24 += 12;
  if (endAmpm === '오전' && endHour24 === 12) endHour24 = 0;

  return {
    date,
    start: `${String(startHour24).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`,
    end: `${String(endHour24).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`,
  };
}

export function createNaverListScrapeService(deps: CreateNaverListScrapeServiceDeps) {
  const { delay, log } = deps;

  async function scrapeExpandedCancelled(page: any, cancelHref: string): Promise<any[]> {
    log('[취소감지2E] legacy UI-click 확장 스캔은 사용하지 않고 RC04 상태 URL로 조회');
    return scrapeCancelledStatusList(page, cancelHref, {
      startDate: todayKst(),
      daysAhead: 30,
      dateDropdownType: 'MONTH',
      limit: 50,
    });
  }

  async function scrapeBookingStatusList(page: any, sourceUrl: string, {
    statusCode,
    startDate = todayKst(),
    endDate,
    daysAhead = 30,
    dateDropdownType = 'RANGE',
    limit = 100,
  }: {
    statusCode: string;
    startDate?: string;
    endDate?: string;
    daysAhead?: number;
    dateDropdownType?: string;
    limit?: number;
  }): Promise<any[]> {
    const url = buildBookingStatusListUrl(sourceUrl, {
      statusCode,
      startDate,
      endDate,
      daysAhead,
      dateDropdownType,
    });
    log(`🔎 [네이버상태목록] ${statusCode} ${startDate}~${endDate || addDaysKst(startDate, daysAhead)}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector(
      'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
      { timeout: 20000 },
    ).catch(() => null);
    await delay(500);
    return scrapeNewestBookingsFromList(page, limit);
  }

  async function scrapeCancelledStatusList(page: any, sourceUrl: string, options: Record<string, any> = {}): Promise<any[]> {
    return scrapeBookingStatusList(page, sourceUrl, { ...options, statusCode: 'RC04' });
  }

  async function scrapeConfirmedStatusList(page: any, sourceUrl: string, options: Record<string, any> = {}): Promise<any[]> {
    return scrapeBookingStatusList(page, sourceUrl, { ...options, statusCode: 'RC03' });
  }

  async function scrapeNewestBookingsFromList(page: any, limit = 5): Promise<any[]> {
    await page.waitForSelector(
      'a[class*="contents-user"], [class*="nodata-area"], [class*="nodata"], .nodata',
      { timeout: 20000 },
    );

    await page.waitForFunction(() => {
      const rows = document.querySelectorAll('a[class*="contents-user"]');
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
      const noDataVisible = !!noData && (noData as HTMLElement).offsetParent !== null;
      return rows.length > 0 || noDataVisible;
    }, { timeout: 20000 });

    const scraped = await page.evaluate((n: number) => {
      const sameDayFallbackDate = (() => {
        try {
          const url = new URL(location.href);
          if (url.searchParams.get('dateFilter') !== 'USEDATE') return null;
          const startDate = url.searchParams.get('startDateTime');
          const endDate = url.searchParams.get('endDateTime');
          if (startDate && startDate === endDate) return startDate;
        } catch (_e) {}
        return null;
      })();
      const noData = document.querySelector('[class*="nodata-area"], [class*="nodata"], .nodata');
      const noDataVisible = !!noData && (noData as HTMLElement).offsetParent !== null;

      const rows = Array.from(document.querySelectorAll('a[class*="contents-user"]')).slice(0, n);
      if (noDataVisible && rows.length === 0) return [];
      if (rows.length === 0) return [];

      const out: any[] = [];
      for (const row of rows) {
        const nameEl = row.querySelector('[class*="name__"]');
        const phoneEl = row.querySelector('[class*="phone__"] span');
        const bookDateEl = row.querySelector('[class*="book-date__"]');
        const hostEl = row.querySelector('[class*="host__"]');
        const bookIdEl = row.querySelector('[class*="book-number__"]');

        const name = String(nameEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const phoneText = String(phoneEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const phone = phoneText ? phoneText.replace(/\D/g, '') : null;
        const bookingId = String(bookIdEl?.textContent || '').replace(/\s+/g, ' ').trim();

        const dateTimeText = String(bookDateEl?.textContent || '').replace(/\s+/g, ' ').trim();
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
          } else if (sameDayFallbackDate) {
            date = sameDayFallbackDate;
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
                endAmpm = startHour === 12 || endHour >= startHour ? '오전' : '오후';
              } else if (endHour === 12 && startAmpm === '오전') {
                endAmpm = '오후';
              } else if (startAmpm === '오후' && endHour >= 1 && endHour <= 11) {
                endAmpm = startHour === 12 || endHour >= startHour ? '오후' : '오전';
              } else {
                endAmpm = startAmpm;
              }
            }

            let startHour24 = startHour;
            let endHour24 = endHour;
            const startMinute = String(startMin).padStart(2, '0');
            const endMinute = String(endMin).padStart(2, '0');
            if (startAmpm === '오후' && startHour24 < 12) startHour24 += 12;
            if (startAmpm === '오전' && startHour24 === 12) startHour24 = 0;
            if (endAmpm === '오후' && endHour24 < 12) endHour24 += 12;
            if (endAmpm === '오전' && endHour24 === 12) endHour24 = 0;
            start = `${String(startHour24).padStart(2, '0')}:${startMinute}`;
            end = `${String(endHour24).padStart(2, '0')}:${endMinute}`;
          }
        }

        const hostText = String(hostEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const roomMatch = hostText.match(/\b(A1|A2|B)\b/i);
        const room = roomMatch ? roomMatch[1].toUpperCase() : null;

        if (phone && start && end && date) {
          let phoneFormatted = phone;
          if (phoneFormatted.length === 11) {
            phoneFormatted = `${phoneFormatted.slice(0, 3)}-${phoneFormatted.slice(3, 7)}-${phoneFormatted.slice(7)}`;
          }
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

    return scraped.map((booking: any) => {
      const parsed = parseNaverDateTimeText(booking?.raw?.dateTimeText, booking?.date);
      if (!parsed) return booking;
      return {
        ...booking,
        date: parsed.date,
        start: parsed.start,
        end: parsed.end,
      };
    });
  }

  return {
    scrapeBookingStatusList,
    scrapeCancelledStatusList,
    scrapeConfirmedStatusList,
    scrapeExpandedCancelled,
    scrapeNewestBookingsFromList,
  };
}
