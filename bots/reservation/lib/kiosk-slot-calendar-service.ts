type Logger = (message: string) => void;

export type CreateKioskSlotCalendarServiceDeps = {
  log: Logger;
  delay: (ms: number) => Promise<void>;
  isSettingsPanelVisible: (page: any) => Promise<boolean>;
};

export function createKioskSlotCalendarService(deps: CreateKioskSlotCalendarServiceDeps) {
  const { log, delay, isSettingsPanelVisible } = deps;

  async function clickRoomAvailableSlot(page: any, roomRaw: string, startTime: string) {
    const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
    log(`  🏠 룸 슬롯 클릭: roomRaw="${roomRaw}" → roomType="${roomType}" time="${startTime}"`);

    const [hh, mm] = (startTime || '09:00').split(':').map(Number);
    const isAM = hh < 12;
    const displayHour = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
    const ampm = isAM ? '오전' : '오후';
    const hourMin = `${displayHour}:${String(mm).padStart(2, '0')}`;
    const timeDisplay = `${ampm} ${hourMin}`;
    log(`  시간 표시: "${timeDisplay}"`);

    const result = await page.evaluate(async (roomTypeArg: string, timeDisplayArg: string, ampmArg: string, hourMinArg: string, startTimeArg: string) => {
      const isVisible = (el: any) => {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
      };
      const normalize = (text: string) => String(text || '').replace(/\s+/g, ' ').trim();
      const to24Hour = (label: string) => {
        const text = normalize(label);
        const m = text.match(/(오전|오후|자정)\s*(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const [, meridiem, hourStr, minStr] = m;
        let hour = Number(hourStr);
        const minute = Number(minStr);
        if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
        if (meridiem === '자정') hour = 0;
        else if (meridiem === '오전') hour = hour === 12 ? 0 : hour;
        else if (meridiem === '오후') hour = hour === 12 ? 12 : hour + 12;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      };
      const roomPattern = new RegExp(`^${roomTypeArg}(?:룸|\\b)`, 'i');
      const targetLabel = normalize(`${ampmArg} ${hourMinArg}`);

      const headerCells = Array.from(document.querySelectorAll('[class*="Calendar__inner-header"] [class*="Calendar__week-row"] [class*="Calendar__week-cell"]'));
      const roomHeaders = headerCells
        .map((cell, idx) => ({ idx, text: normalize((cell as HTMLElement).textContent || '') }))
        .filter((row) => row.text.length > 0);
      const roomIndex = roomHeaders.findIndex((row) => roomPattern.test(row.text) || row.text === roomTypeArg);
      if (roomIndex < 0) {
        return { found: false, reason: 'room_header_not_found', roomHeaders: roomHeaders.map((row) => row.text) };
      }

      const scrollCalendarToTarget = (targetEl: any) => {
        if (!targetEl) return null;
        const rowWrap = document.querySelector('[class*="Calendar__row-wrap"]');
        const innerWrap = document.querySelector('[class*="Calendar__inner-wrap"]');
        const scrollContainer = rowWrap || innerWrap || targetEl.parentElement;
        if (!scrollContainer) return null;

        const timelineEls = Array.from(document.querySelectorAll('[class*="Calendar__time-col-wrap"] [class*="Calendar__week-timeline"]'));
        const targetIndex = timelineEls.indexOf(targetEl);
        const rowHeight = (() => {
          for (let i = 1; i < timelineEls.length; i += 1) {
            const prevRect = (timelineEls[i - 1] as HTMLElement).getBoundingClientRect();
            const currRect = (timelineEls[i] as HTMLElement).getBoundingClientRect();
            const delta = Math.abs(currRect.top - prevRect.top);
            if (delta > 8) return delta;
          }
          return 96;
        })();

        const viewportHeight = (scrollContainer as HTMLElement).clientHeight || window.innerHeight || 0;
        const targetOffsetTop = (targetEl as HTMLElement).offsetTop || targetIndex * rowHeight;
        const nextScrollTop = Math.max(0, targetOffsetTop - Math.max(0, viewportHeight / 2 - rowHeight));
        (scrollContainer as HTMLElement).scrollTop = nextScrollTop;
        if (rowWrap && rowWrap !== scrollContainer) (rowWrap as HTMLElement).scrollTop = nextScrollTop;
        if (innerWrap && innerWrap !== scrollContainer) (innerWrap as HTMLElement).scrollTop = nextScrollTop;

        return {
          targetIndex,
          rowHeight: Math.round(rowHeight),
          scrollTop: Math.round(nextScrollTop),
          viewportHeight: Math.round(viewportHeight),
          scrollContainerClass: String((scrollContainer as HTMLElement).className || '').slice(0, 120),
        };
      };

      const allTimelineEls = Array.from(document.querySelectorAll('[class*="Calendar__time-col-wrap"] [class*="Calendar__week-timeline"]'));
      const targetTimelineEl = allTimelineEls.find((row: any) => {
        const ampmText = normalize(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '');
        const timeText = normalize(row.querySelector('[class*="Calendar__time__"]')?.textContent || '');
        return normalize(`${ampmText} ${timeText}`) === targetLabel;
      });
      const scrollDebug = scrollCalendarToTarget(targetTimelineEl);
      if (scrollDebug) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      const timelineRows = allTimelineEls
        .filter((row: any) => isVisible(row))
        .map((row: any) => {
          const ampmText = normalize(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '');
          const timeText = normalize(row.querySelector('[class*="Calendar__time__"]')?.textContent || '');
          const label = normalize(`${ampmText} ${timeText}`);
          const rect = (row as HTMLElement).getBoundingClientRect();
          return {
            label,
            slot24: to24Hour(label),
            y: rect.top + rect.height / 2,
          };
        });

      if (timelineRows.length === 0) {
        return { found: false, reason: 'no_visible_timeline_rows' };
      }

      const gridRows = Array.from(document.querySelectorAll('[class*="Calendar__week-cell-daily-row"]'))
        .map((dailyRow: any) => {
          const rowRect = dailyRow.getBoundingClientRect();
          if (rowRect.height <= 0 || rowRect.bottom < 0 || rowRect.top > window.innerHeight) return null;
          const roomCells = Array.from(dailyRow.children).filter((cell: any) => {
            const rect = cell.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (roomCells.length === 0) return null;
          return {
            y: rowRect.top + rowRect.height / 2,
            roomCells,
          };
        })
        .filter(Boolean);

      if (gridRows.length === 0) {
        return { found: false, reason: 'no_visible_grid_rows' };
      }

      const rows = timelineRows
        .map((timeline, idx) => ({ idx, timeline, grid: (gridRows as any[])[idx] || null }))
        .filter((row) => row.grid && row.timeline.slot24);

      const targetRows = rows.filter((row) => row.timeline.slot24 === startTimeArg);
      if (targetRows.length === 0) {
        return {
          found: false,
          reason: 'target_row_not_found',
          target: startTimeArg,
          targetLabel,
          scrollDebug,
          visibleRows: rows.slice(0, 16).map((row) => ({
            idx: row.idx,
            label: row.timeline.label,
            slot24: row.timeline.slot24,
          })),
        };
      }

      const fallbackCandidates: any[] = [];
      const tryClickRows = (candidateRows: any[], mode = 'exact') => {
        for (const row of candidateRows) {
          const targetCell = row.grid.roomCells[roomIndex];
          if (!targetCell) {
            fallbackCandidates.push({ idx: row.idx, slot24: row.timeline.slot24, label: row.timeline.label, mode, reason: 'room_cell_missing' });
            continue;
          }

          const button = targetCell.querySelector('button.calendar-btn, button[class*="calendar-btn"]');
          if (!button) {
            fallbackCandidates.push({ idx: row.idx, slot24: row.timeline.slot24, label: row.timeline.label, mode, reason: 'button_missing' });
            continue;
          }

          const cls = String((button as HTMLElement).className || '');
          const text = normalize((button as HTMLElement).textContent || '');
          const isSoldout = cls.includes('soldout') || cls.includes('disabled');
          const isBlocked = cls.includes('suspended') || cls.includes('btn-danger') || text.includes('예약불가');
          const isAvailable = cls.includes('avail') || cls.includes('btn-info') || text.includes('예약가능');

          if (isSoldout || isBlocked || !isAvailable) {
            fallbackCandidates.push({
              idx: row.idx,
              slot24: row.timeline.slot24,
              label: row.timeline.label,
              mode,
              reason: 'button_not_available',
              btnClass: cls.slice(0, 80),
              btnText: text,
            });
            continue;
          }

          (button as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
          (button as HTMLElement).click();
          const rect = (button as HTMLElement).getBoundingClientRect();
          return {
            found: true,
            clicked: true,
            btnText: text,
            btnClass: cls.slice(0, 80),
            pos: { cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2) },
            targetLabel: row.timeline.label,
            targetSlot24: row.timeline.slot24,
            fallbackFromSlot24: mode === 'fallback_next_slot' ? startTimeArg : null,
            fallbackUsed: mode === 'fallback_next_slot',
            scrollDebug,
            fallbackCandidates,
          };
        }
        return null;
      };

      const exactClick = tryClickRows(targetRows, 'exact');
      if (exactClick) return exactClick;

      const laterRows = rows.filter((row) => row.timeline.slot24 > startTimeArg);
      const fallbackClick = tryClickRows(laterRows, 'fallback_next_slot');
      if (fallbackClick) return fallbackClick;

      return {
        found: false,
        reason: 'no_available_button_near_target_slot',
        target: startTimeArg,
        targetLabel: timeDisplayArg,
        scrollDebug,
        fallbackCandidates,
      };
    }, roomType, timeDisplay, ampm, hourMin, startTime);

    const looksAlreadyBlocked =
      result?.reason === 'no_available_button_near_target_slot'
      && Array.isArray(result?.fallbackCandidates)
      && result.fallbackCandidates.length > 0
      && result.fallbackCandidates.every((candidate: any) => {
        if (candidate?.reason !== 'button_not_available') return false;
        const btnText = String(candidate?.btnText || '');
        const btnClass = String(candidate?.btnClass || '');
        return btnText.includes('예약불가') || btnClass.includes('suspended') || btnClass.includes('btn-danger');
      });

    log(`  예약가능 버튼: ${JSON.stringify(result)}`);
    if (!result.found || !result.clicked) {
      return {
        ok: false,
        reason: result?.reason || 'slot_click_failed',
        looksAlreadyBlocked,
        selectedStart: null,
        raw: result,
      };
    }

    await delay(1200);
    if (await isSettingsPanelVisible(page)) {
      const effectiveStart = result.targetSlot24 || startTime;
      log(`  ✅ 설정 패널 열림 확인${result.targetLabel ? ` → 시작시간 ${effectiveStart} (${result.targetLabel})` : ''}`);
      return {
        ok: true,
        reason: 'clicked',
        looksAlreadyBlocked: false,
        selectedStart: effectiveStart,
        raw: result,
      };
    }

    log('  ❌ 버튼 클릭 후에도 설정 패널이 열리지 않음');
    return {
      ok: false,
      reason: 'panel_not_opened',
      looksAlreadyBlocked: false,
      selectedStart: null,
      raw: result,
    };
  }

  async function clickRoomSuspendedSlot(page: any, roomRaw: string, startTime: string) {
    const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
    log(`  🏠 suspended 슬롯 클릭: roomRaw="${roomRaw}" → roomType="${roomType}" time="${startTime}"`);

    const [hh, mm] = (startTime || '09:00').split(':').map(Number);
    const isAM = hh < 12;
    const displayHour = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
    const ampm = isAM ? '오전' : '오후';
    const hourMin = `${displayHour}:${String(mm).padStart(2, '0')}`;
    const timeDisplay = `${ampm} ${hourMin}`;
    log(`  시간 표시: "${timeDisplay}"`);

    const result = await page.evaluate(async (roomTypeArg: string, timeDisplayArg: string, ampmArg: string, hourMinArg: string, startTimeArg: string) => {
      const isVisible = (el: any) => {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
      };
      const normalize = (text: string) => String(text || '').replace(/\s+/g, ' ').trim();
      const to24Hour = (label: string) => {
        const text = normalize(label);
        const m = text.match(/(오전|오후|자정)\s*(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const [, meridiem, hourStr, minStr] = m;
        let hour = Number(hourStr);
        const minute = Number(minStr);
        if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
        if (meridiem === '자정') hour = 0;
        else if (meridiem === '오전') hour = hour === 12 ? 0 : hour;
        else if (meridiem === '오후') hour = hour === 12 ? 12 : hour + 12;
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      };
      const roomPattern = new RegExp(`^${roomTypeArg}(?:룸|\\b)`, 'i');
      const targetLabel = normalize(`${ampmArg} ${hourMinArg}`);

      const headerCells = Array.from(document.querySelectorAll('[class*="Calendar__inner-header"] [class*="Calendar__week-row"] [class*="Calendar__week-cell"]'));
      const roomHeaders = headerCells
        .map((cell, idx) => ({ idx, text: normalize((cell as HTMLElement).textContent || '') }))
        .filter((row) => row.text.length > 0);
      const roomIndex = roomHeaders.findIndex((row) => roomPattern.test(row.text) || row.text === roomTypeArg);
      if (roomIndex < 0) {
        return { found: false, reason: 'room_header_not_found', roomHeaders: roomHeaders.map((row) => row.text) };
      }

      const scrollCalendarToTarget = (targetEl: any) => {
        if (!targetEl) return null;
        const rowWrap = document.querySelector('[class*="Calendar__row-wrap"]');
        const innerWrap = document.querySelector('[class*="Calendar__inner-wrap"]');
        const scrollContainer = rowWrap || innerWrap || targetEl.parentElement;
        if (!scrollContainer) return null;

        const timelineEls = Array.from(document.querySelectorAll('[class*="Calendar__time-col-wrap"] [class*="Calendar__week-timeline"]'));
        const targetIndex = timelineEls.indexOf(targetEl);
        const rowHeight = (() => {
          for (let i = 1; i < timelineEls.length; i += 1) {
            const prevRect = (timelineEls[i - 1] as HTMLElement).getBoundingClientRect();
            const currRect = (timelineEls[i] as HTMLElement).getBoundingClientRect();
            const delta = Math.abs(currRect.top - prevRect.top);
            if (delta > 8) return delta;
          }
          return 96;
        })();

        const viewportHeight = (scrollContainer as HTMLElement).clientHeight || window.innerHeight || 0;
        const targetOffsetTop = (targetEl as HTMLElement).offsetTop || targetIndex * rowHeight;
        const nextScrollTop = Math.max(0, targetOffsetTop - Math.max(0, viewportHeight / 2 - rowHeight));
        (scrollContainer as HTMLElement).scrollTop = nextScrollTop;
        if (rowWrap && rowWrap !== scrollContainer) (rowWrap as HTMLElement).scrollTop = nextScrollTop;
        if (innerWrap && innerWrap !== scrollContainer) (innerWrap as HTMLElement).scrollTop = nextScrollTop;

        return {
          targetIndex,
          rowHeight: Math.round(rowHeight),
          scrollTop: Math.round(nextScrollTop),
          viewportHeight: Math.round(viewportHeight),
          scrollContainerClass: String((scrollContainer as HTMLElement).className || '').slice(0, 120),
        };
      };

      const allTimelineEls = Array.from(document.querySelectorAll('[class*="Calendar__time-col-wrap"] [class*="Calendar__week-timeline"]'));
      const targetTimelineEl = allTimelineEls.find((row: any) => {
        const ampmText = normalize(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '');
        const timeText = normalize(row.querySelector('[class*="Calendar__time__"]')?.textContent || '');
        return normalize(`${ampmText} ${timeText}`) === targetLabel;
      });
      const scrollDebug = scrollCalendarToTarget(targetTimelineEl);
      if (scrollDebug) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      const timelineRows = allTimelineEls
        .filter((row: any) => isVisible(row))
        .map((row: any) => {
          const ampmText = normalize(row.querySelector('[class*="Calendar__time-ampm"]')?.textContent || '');
          const timeText = normalize(row.querySelector('[class*="Calendar__time__"]')?.textContent || '');
          const label = normalize(`${ampmText} ${timeText}`);
          const rect = (row as HTMLElement).getBoundingClientRect();
          return {
            label,
            slot24: to24Hour(label),
            y: rect.top + rect.height / 2,
          };
        });

      const gridRows = Array.from(document.querySelectorAll('[class*="Calendar__week-cell-daily-row"]'))
        .map((dailyRow: any) => {
          const rowRect = dailyRow.getBoundingClientRect();
          if (rowRect.height <= 0 || rowRect.bottom < 0 || rowRect.top > window.innerHeight) return null;
          const roomCells = Array.from(dailyRow.children).filter((cell: any) => {
            const rect = cell.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (roomCells.length === 0) return null;
          return {
            y: rowRect.top + rowRect.height / 2,
            roomCells,
          };
        })
        .filter(Boolean);

      const rows = timelineRows
        .map((timeline, idx) => ({ idx, timeline, grid: (gridRows as any[])[idx] || null }))
        .filter((row) => row.grid && row.timeline.slot24);

      const targetRows = rows.filter((row) => row.timeline.slot24 === startTimeArg);
      if (targetRows.length === 0) {
        return {
          found: false,
          reason: 'target_row_not_found',
          target: startTimeArg,
          targetLabel,
          scrollDebug,
          visibleRows: rows.slice(0, 16).map((row) => ({
            idx: row.idx,
            label: row.timeline.label,
            slot24: row.timeline.slot24,
          })),
        };
      }

      const fallbackCandidates: any[] = [];
      for (const row of targetRows) {
        const targetCell = row.grid.roomCells[roomIndex];
        if (!targetCell) {
          fallbackCandidates.push({ idx: row.idx, slot24: row.timeline.slot24, label: row.timeline.label, reason: 'room_cell_missing' });
          continue;
        }

        const button = targetCell.querySelector('button.calendar-btn, button[class*="calendar-btn"]');
        if (!button) {
          fallbackCandidates.push({ idx: row.idx, slot24: row.timeline.slot24, label: row.timeline.label, reason: 'button_missing' });
          continue;
        }

        const cls = String((button as HTMLElement).className || '');
        const text = normalize((button as HTMLElement).textContent || '');
        const isSuspended = cls.includes('suspended') || cls.includes('btn-danger') || text.includes('예약불가');
        if (!isSuspended) {
          fallbackCandidates.push({
            idx: row.idx,
            slot24: row.timeline.slot24,
            label: row.timeline.label,
            reason: 'button_not_suspended',
            btnClass: cls.slice(0, 80),
            btnText: text,
          });
          continue;
        }

        (button as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
        (button as HTMLElement).click();
        const rect = (button as HTMLElement).getBoundingClientRect();
        return {
          found: true,
          clicked: true,
          btnText: text,
          btnClass: cls.slice(0, 80),
          pos: { cx: Math.round(rect.left + rect.width / 2), cy: Math.round(rect.top + rect.height / 2) },
          targetLabel: row.timeline.label,
          targetSlot24: row.timeline.slot24,
          scrollDebug,
          fallbackCandidates,
        };
      }

      return {
        found: false,
        reason: 'no_suspended_button_near_target_slot',
        target: startTimeArg,
        targetLabel: timeDisplayArg,
        scrollDebug,
        fallbackCandidates,
      };
    }, roomType, timeDisplay, ampm, hourMin, startTime);

    log(`  suspended 버튼: ${JSON.stringify(result)}`);
    if (!result.found || !result.clicked) return false;
    await delay(1500);
    return true;
  }

  return {
    clickRoomAvailableSlot,
    clickRoomSuspendedSlot,
  };
}
