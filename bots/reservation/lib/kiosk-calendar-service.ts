type Logger = (message: string) => void;

export type CreateKioskCalendarServiceDeps = {
  log: Logger;
  delay: (ms: number) => Promise<void>;
  bookingUrl: string;
  naverId: string;
  naverPw: string;
  publishReservationAlert: (payload: Record<string, any>) => any;
  getTodayKST: () => string;
};

export function createKioskCalendarService(deps: CreateKioskCalendarServiceDeps) {
  const {
    log,
    delay,
    bookingUrl,
    naverId,
    naverPw,
    publishReservationAlert,
    getTodayKST,
  } = deps;

  async function naverBookingLogin(page: any) {
    log('🔐 네이버 booking 로그인 시작...');

    await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);

    const alreadyIn = await page.evaluate(() => {
      const t = document.body?.innerText || document.body?.textContent || '';
      return t.includes('예약 불가') || t.includes('예약현황') || t.includes('booking-calendar')
        || document.querySelector('[class*="calendar"]') !== null
        || document.querySelector('[class*="Calendar"]') !== null;
    });

    if (alreadyIn) {
      log('✅ 이미 로그인 상태 (캘린더 화면 감지)');
      return true;
    }

    const hasLoginForm = await page.$('input#id, input[name="id"], input#pw, input[name="pw"]');
    if (!hasLoginForm) {
      const currentUrl = page.url();
      log(`ℹ️ 로그인 폼 없음. URL: ${currentUrl.slice(0, 100)}`);
      const idLoginLink = await page.$('a[href*="id.naver.com"], a[href*="login"]');
      if (idLoginLink) {
        await idLoginLink.click();
        await delay(3000);
      }
    }

    await page.waitForSelector('input#id, input[name="id"]', { timeout: 10000 }).catch(() => null);
    const idEl = await page.$('input#id') || await page.$('input[name="id"]');
    const pwEl = await page.$('input#pw') || await page.$('input[name="pw"]');

    if (!idEl || !pwEl) {
      log('⚠️ 로그인 폼을 찾을 수 없음');
      return false;
    }

    await idEl.click({ clickCount: 3 });
    await page.type('input#id, input[name="id"]', naverId, { delay: 30 }).catch(() =>
      idEl.type(naverId, { delay: 30 }),
    );
    await pwEl.click({ clickCount: 3 });
    await page.type('input#pw, input[name="pw"]', naverPw, { delay: 30 }).catch(() =>
      pwEl.type(naverPw, { delay: 30 }),
    );

    const loginBtnSel = (await page.$('button#log\\.login')) ? 'button#log\\.login'
      : (await page.$('button[type="submit"]')) ? 'button[type="submit"]'
      : null;

    if (loginBtnSel) {
      await page.click(loginBtnSel);
    } else {
      await page.keyboard.press('Enter');
    }

    await delay(5000);

    const loggedIn = await page.evaluate(() => {
      const t = document.body?.innerText || document.body?.textContent || '';
      return t.includes('예약 불가') || t.includes('예약현황') || t.includes('캘린더')
        || document.querySelector('[class*="calendar"]') !== null
        || document.querySelector('[class*="Calendar"]') !== null;
    });

    if (loggedIn) {
      log('✅ 네이버 booking 로그인 성공');
      return true;
    }

    const secCheck = await page.evaluate(() => {
      const url = window.location.href;
      const text = document.body?.innerText || '';
      return {
        url: url.slice(0, 120),
        needsSecurity: /보안|인증|OTP|문자|전화|기기/.test(text),
      };
    });

    log(`⚠️ 로그인 후 상태: ${JSON.stringify(secCheck)}`);
    if (secCheck.needsSecurity) {
      publishReservationAlert({
        from_bot: 'jimmy',
        event_type: 'alert',
        alert_level: 4,
        message: '🔐 네이버 예약관리 보안인증 필요!\n수동 로그인 후 재시작 필요',
      });
    }
    return false;
  }

  async function selectBookingDate(page: any, date: string) {
    const today = getTodayKST();
    const isToday = date === today;
    const [yearStr, monthStr] = date.split('-');
    const targetYear = parseInt(yearStr, 10);
    const targetMonth = parseInt(monthStr, 10);
    const targetDay = parseInt(date.split('-')[2], 10);
    const targetMonthKey = targetYear * 12 + targetMonth;
    const [todayYearStr, todayMonthStr] = getTodayKST().split('-');
    const currentMonthKey = parseInt(todayYearStr, 10) * 12 + parseInt(todayMonthStr, 10);
    const headerText = `${targetYear}.${targetMonth}`;

    log(`  📅 날짜 선택: ${date} (헤더: "${headerText}")`);

    const dateInfoSel = '[class*="DatePeriodCalendar__date-info"]';
    await page.waitForSelector(dateInfoSel, { timeout: 10000 });
    await page.click(dateInfoSel);
    await delay(1000);

    let found = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const coords = await page.evaluate((headerTextArg: string, targetDayArg: number, isTodayArg: boolean) => {
        const dayStr = String(targetDayArg);

        let targetContainer: Element | null = null;
        for (const c of document.querySelectorAll('[class*="DatePeriodCalendar__monthly"]')) {
          const topEl = c.querySelector('[class*="Calendar__monthly-top"]');
          const topText = (topEl?.textContent || c.textContent || '').replace(/\s+/g, '');
          if (topText.includes(headerTextArg.replace(/\s+/g, ''))) {
            targetContainer = c;
            break;
          }
        }

        if (!targetContainer) {
          return { found: false, reason: `container for "${headerTextArg}" not found` };
        }

        for (const btn of targetContainer.querySelectorAll('button[class*="btn-day"], button[class*="Calendar__btn"]')) {
          const txt = (btn.textContent || '').trim();
          if (isTodayArg && txt.startsWith('오늘')) {
            // pass
          } else {
            if (!txt.startsWith(dayStr)) continue;
            if (txt.length > dayStr.length && /\d/.test(txt[dayStr.length])) continue;
          }
          if (btn.getAttribute('aria-disabled') === 'true') continue;
          const r = (btn as HTMLElement).getBoundingClientRect();
          if (r.width <= 0) continue;
          return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, method: 'btn-day', txt: txt.slice(0, 10) };
        }

        for (const cell of targetContainer.querySelectorAll('td, [role="gridcell"]')) {
          const txt = (cell.textContent || '').trim();
          if (isTodayArg && txt.startsWith('오늘')) {
            // pass
          } else {
            if (!txt.startsWith(dayStr)) continue;
            if (txt.length > dayStr.length && /\d/.test(txt[dayStr.length])) continue;
          }
          if (cell.getAttribute('aria-disabled') === 'true') continue;
          const cls = String((cell as HTMLElement).className || '').toLowerCase();
          if (cls.includes('disabled') || cls.includes('outside')) continue;
          const r = (cell as HTMLElement).getBoundingClientRect();
          if (r.width <= 0) continue;
          return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, method: 'td', txt: txt.slice(0, 10) };
        }
        return { found: false, reason: `day ${dayStr} not found in container`, isToday: isTodayArg };
      }, headerText, targetDay, isToday);

      log(`  좌표 탐색 (attempt ${attempt + 1}): ${JSON.stringify(coords)}`);

      if (coords.found) {
        await page.mouse.click(coords.x, coords.y);
        log(`  ✅ 날짜 셀 mouse.click: (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
        found = true;
        await delay(400);
        break;
      }

      const navCoords = await page.evaluate((targetMonthKeyArg: number, currentMonthKeyArg: number) => {
        const monthlyContainers = Array.from(document.querySelectorAll('[class*="DatePeriodCalendar__monthly"]'))
          .filter((el) => (el as HTMLElement).offsetParent !== null);

        const headers = Array.from(document.querySelectorAll('*')).filter((el) => {
          if ((el as HTMLElement).offsetParent === null) return false;
          const txt = (el.textContent || '').trim();
          if (!/^\d{4}\.\d{1,2}$/.test(txt)) return false;
          const r = (el as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.width < 300 && r.height > 0 && r.height < 60;
        }).map((el) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const text = (el.textContent || '').trim();
          const match = text.match(/^(\d{4})\.(\d{1,2})$/);
          return {
            text,
            key: match ? Number(match[1]) * 12 + Number(match[2]) : null,
            left: rect.left,
          };
        }).filter((h) => Number.isFinite(h.key)).sort((a: any, b: any) => a.left - b.left);

        const popupRoot = monthlyContainers.length > 0 ? monthlyContainers[0].parentElement : null;

        if (headers.length === 0) {
          const prevBtn = popupRoot?.querySelector('button[class*="DatePeriodCalendar__prev"]');
          const nextBtn = popupRoot?.querySelector('button[class*="DatePeriodCalendar__next"]');
          const direction = targetMonthKeyArg >= currentMonthKeyArg ? 'next' : 'prev';
          const exactBtn = popupRoot?.querySelector(
            direction === 'next'
              ? 'button[class*="DatePeriodCalendar__next"]'
              : 'button[class*="DatePeriodCalendar__prev"]',
          );
          if (exactBtn && (exactBtn as HTMLElement).offsetParent !== null) {
            const r = (exactBtn as HTMLElement).getBoundingClientRect();
            return {
              found: true,
              x: r.left + r.width / 2,
              y: r.top + r.height / 2,
              direction,
              via: 'popup-month-button-no-headers',
              hasPrev: Boolean(prevBtn),
              hasNext: Boolean(nextBtn),
            };
          }
          return {
            found: false,
            reason: 'no month headers',
            direction,
            hasPrev: Boolean(prevBtn),
            hasNext: Boolean(nextBtn),
          };
        }

        const minKey = headers[0].key;
        const maxKey = headers[headers.length - 1].key;
        const direction = targetMonthKeyArg > maxKey ? 'next' : targetMonthKeyArg < minKey ? 'prev' : 'next';
        const exactBtn = popupRoot?.querySelector(
          direction === 'next'
            ? 'button[class*="DatePeriodCalendar__next"]'
            : 'button[class*="DatePeriodCalendar__prev"]',
        );
        if (exactBtn && (exactBtn as HTMLElement).offsetParent !== null) {
          const r = (exactBtn as HTMLElement).getBoundingClientRect();
          return {
            found: true,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            direction,
            via: 'date-period-button',
            visibleMonths: headers.map((h: any) => h.text),
          };
        }

        return {
          found: false,
          reason: 'nav button not found',
          direction,
          visibleMonths: headers.map((h: any) => h.text),
        };
      }, targetMonthKey, currentMonthKey);

      log(`  → 달 이동 (attempt ${attempt + 1}): ${JSON.stringify(navCoords)}`);
      if (!navCoords.found) break;
      await page.mouse.click(navCoords.x, navCoords.y);
      await delay(800);
    }

    if (!found) {
      log('  ❌ 날짜 선택 실패');
      return false;
    }

    const applyClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        if ((btn.textContent || '').trim() === '적용' && (btn as HTMLElement).offsetParent !== null) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    log(`  [3단계] 적용 버튼: ${applyClicked}`);
    if (!applyClicked) return false;

    await delay(2000);
    return true;
  }

  async function verifyBlockInGrid(page: any, roomRaw: string, start: string, end: string) {
    const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
    log(`  🔍 차단 최종 확인: room=${roomType} ${start}~${end}`);

    function buildRequestedSlots(startTime: string, endTime: string) {
      const [sh, sm] = String(startTime || '').split(':').map(Number);
      const [eh, em] = String(endTime || '').split(':').map(Number);
      if ([sh, sm, eh, em].some(Number.isNaN)) return [];
      const startMinutes = sh * 60 + sm;
      const endMinutes = eh * 60 + em;
      const slots: string[] = [];
      for (let minute = startMinutes; minute < endMinutes; minute += 30) {
        slots.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
      }
      return slots;
    }

    const requestedSlots = buildRequestedSlots(start, end);
    if (requestedSlots.length === 0) {
      log('  ⚠️ 차단 검증 슬롯 계산 실패');
      return false;
    }

    const serializedRoomType = JSON.stringify(roomType);
    const serializedRequestedSlots = JSON.stringify(requestedSlots);
    const result = await page.evaluate(`(async () => {
      const roomTypeArg = ${serializedRoomType};
      const requestedSlotsArg = ${serializedRequestedSlots};

      function addThirtyMinutes(time24) {
        const [hh, mm] = String(time24 || '').split(':').map(Number);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
        const total = hh * 60 + mm + 30;
        return \`\${String(Math.floor(total / 60)).padStart(2, '0')}:\${String(total % 60).padStart(2, '0')}\`;
      }

      function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
      }

      function parseSlotState(btn) {
        const cls = String(btn.className || '');
        const title = String(btn.getAttribute('title') || '').trim();
        const txt = String(btn.textContent || '').trim().replace(/\\s+/g, '');
        const isBlocked = cls.includes('suspended') || cls.includes('btn-danger') || title === '예약불가' || txt.includes('예약불가');
        const isAvailable = cls.includes('avail') || cls.includes('btn-info') || title === '예약가능' || txt.includes('예약가능');
        let state = 'unknown';
        if (isBlocked) state = 'blocked';
        else if (isAvailable) state = 'available';
        return { state, cls, title, txt };
      }

      function toDisplayLabel(time24) {
        const [hh, mm] = String(time24 || '').split(':').map(Number);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
        const isAM = hh < 12;
        const dispH = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
        return \`\${isAM ? '오전' : '오후'} \${dispH}:\${String(mm).padStart(2, '0')}\`;
      }

      function to24Hour(label) {
        const text = String(label || '').replace(/\\s+/g, ' ').trim();
        const m = text.match(/(오전|오후|자정)\\s*(\\d{1,2}):(\\d{2})/);
        if (!m) return null;
        const [, meridiem, hourStr, minStr] = m;
        let hour = Number(hourStr);
        const minute = Number(minStr);
        if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
        if (meridiem === '자정') hour = 0;
        else if (meridiem === '오전') hour = hour === 12 ? 0 : hour;
        else if (meridiem === '오후') hour = hour === 12 ? 12 : hour + 12;
        return \`\${String(hour).padStart(2, '0')}:\${String(minute).padStart(2, '0')}\`;
      }

      const roomPattern = new RegExp(\`^\${roomTypeArg}(?:룸|\\\\b)\`, 'i');
      const headerCells = Array.from(document.querySelectorAll('[class*="Calendar__inner-header"] [class*="Calendar__week-row"] [class*="Calendar__week-cell"]'));
      const roomHeaders = headerCells
        .map((cell, idx) => ({ idx, text: String(cell.textContent || '').replace(/\\s+/g, ' ').trim() }))
        .filter((row) => row.text.length > 0);
      const roomIndex = roomHeaders.findIndex((row) => roomPattern.test(row.text) || row.text === roomTypeArg);
      if (roomIndex < 0) {
        return { verified: false, requestedSlots: requestedSlotsArg, matchedSlots: [], missingSlots: requestedSlotsArg.map((slot) => ({ slot, reason: 'room_header_not_found' })) };
      }

      const firstTargetLabel = toDisplayLabel(requestedSlotsArg[0]);
      const allTimelineEls = Array.from(document.querySelectorAll('[class*="Calendar__time-col-wrap"] [class*="Calendar__week-timeline"]'));
      const targetTimelineEl = allTimelineEls.find((row) => {
        const ampmText = String(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '').trim();
        const timeText = String(row.querySelector('[class*="Calendar__time__"]')?.textContent || '').trim();
        return \`\${ampmText} \${timeText}\`.replace(/\\s+/g, ' ').trim() === firstTargetLabel;
      });
      if (targetTimelineEl) {
        const rowWrap = document.querySelector('[class*="Calendar__row-wrap"]');
        const innerWrap = document.querySelector('[class*="Calendar__inner-wrap"]');
        const scrollContainer = rowWrap || innerWrap || targetTimelineEl.parentElement;
        if (scrollContainer) {
          const targetIndex = allTimelineEls.indexOf(targetTimelineEl);
          const rowHeight = (() => {
            for (let i = 1; i < allTimelineEls.length; i += 1) {
              const prevRect = allTimelineEls[i - 1].getBoundingClientRect();
              const currRect = allTimelineEls[i].getBoundingClientRect();
              const delta = Math.abs(currRect.top - prevRect.top);
              if (delta > 8) return delta;
            }
            return 96;
          })();
          const viewportHeight = scrollContainer.clientHeight || window.innerHeight || 0;
          const targetOffsetTop = targetTimelineEl.offsetTop || targetIndex * rowHeight;
          const nextScrollTop = Math.max(0, targetOffsetTop - Math.max(0, viewportHeight / 2 - rowHeight));
          scrollContainer.scrollTop = nextScrollTop;
          if (rowWrap && rowWrap !== scrollContainer) rowWrap.scrollTop = nextScrollTop;
          if (innerWrap && innerWrap !== scrollContainer) innerWrap.scrollTop = nextScrollTop;
        }
      }

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const timelineRows = allTimelineEls
        .filter((row) => isVisible(row))
        .map((row) => {
          const ampmText = String(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '').trim();
          const timeText = String(row.querySelector('[class*="Calendar__time__"]')?.textContent || '').trim();
          const label = \`\${ampmText} \${timeText}\`.replace(/\\s+/g, ' ').trim();
          return { label, slot24: to24Hour(label) };
        });

      const gridRows = Array.from(document.querySelectorAll('[class*="Calendar__week-cell-daily-row"]'))
        .map((dailyRow) => {
          const rect = dailyRow.getBoundingClientRect();
          if (rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight) return null;
          const roomCells = Array.from(dailyRow.children).filter((cell) => {
            const cellRect = cell.getBoundingClientRect();
            return cellRect.width > 0 && cellRect.height > 0;
          });
          if (roomCells.length === 0) return null;
          return { roomCells };
        })
        .filter(Boolean);

      const matchedSlots = [];
      const missingSlots = [];
      for (const slot of requestedSlotsArg) {
        const rowIndex = timelineRows.findIndex((row) => row.slot24 === slot);
        if (rowIndex < 0) {
          missingSlots.push({ slot, reason: 'timeline_row_not_found' });
          continue;
        }
        const gridRow = gridRows[rowIndex];
        if (!gridRow) {
          missingSlots.push({ slot, reason: 'grid_row_not_found' });
          continue;
        }
        const targetCell = gridRow.roomCells[roomIndex];
        if (!targetCell) {
          missingSlots.push({ slot, reason: 'room_cell_not_found' });
          continue;
        }
        const btn = targetCell.querySelector('button.calendar-btn, button[class*="calendar-btn"]');
        if (!btn) {
          missingSlots.push({ slot, reason: 'button_not_found' });
          continue;
        }
        const slotState = parseSlotState(btn);
        if (slotState.state !== 'blocked') {
          missingSlots.push({ slot, reason: 'suspended_not_found' });
          continue;
        }
        const r = btn.getBoundingClientRect();
        matchedSlots.push({
          slot,
          key: \`\${Math.round(r.left)}:\${Math.round(r.top)}:\${Math.round(r.width)}:\${Math.round(r.height)}\`,
          cls: slotState.cls.slice(0, 80),
          title: slotState.title,
          x: Math.round(r.left),
          y: Math.round(r.top),
          h: Math.round(r.height),
          txt: slotState.txt,
        });
      }

      const reconciledMissingSlots = [];
      for (const missing of missingSlots) {
        const missingIndex = requestedSlotsArg.indexOf(missing.slot);
        const prevSlot = requestedSlotsArg[missingIndex - 1];
        const prevMatched = matchedSlots.find((slot) => slot.slot === prevSlot);
        const isTrailingContinuation =
          missingIndex === requestedSlotsArg.length - 1 &&
          prevMatched &&
          addThirtyMinutes(prevMatched.slot) === missing.slot &&
          ['suspended_not_found', 'timeline_row_not_found', 'grid_row_not_found', 'room_cell_not_found', 'button_not_found'].includes(missing.reason);

        if (isTrailingContinuation) {
          matchedSlots.push({
            slot: missing.slot,
            key: \`\${prevMatched.key}:continued\`,
            cls: prevMatched.cls,
            title: prevMatched.title,
            x: prevMatched.x,
            y: prevMatched.y + prevMatched.h,
            h: prevMatched.h,
            txt: prevMatched.txt,
            inferred: true,
          });
          continue;
        }
        reconciledMissingSlots.push(missing);
      }

      return {
        verified: reconciledMissingSlots.length === 0,
        requestedSlots: requestedSlotsArg,
        matchedSlots,
        missingSlots: reconciledMissingSlots,
      };
    })()`);

    log(`  확인 결과: ${JSON.stringify(result)}`);
    return result.verified;
  }

  return {
    naverBookingLogin,
    selectBookingDate,
    verifyBlockInGrid,
  };
}
