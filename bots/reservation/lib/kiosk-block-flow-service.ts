type Logger = (message: string) => void;

export type CreateKioskBlockFlowServiceDeps = {
  log: Logger;
  delay: (ms: number) => Promise<void>;
  bookingUrl: string;
  roundUpToHalfHour: (time: string) => string;
  toClockMinutes: (time: string) => number | null;
  maskName: (name: string) => string;
  selectBookingDate: (page: any, date: string) => Promise<boolean>;
  verifyBlockInGrid: (page: any, room: string, start: string, end: string) => Promise<boolean>;
  clickRoomAvailableSlot: (page: any, room: string, start: string) => Promise<any>;
  clickRoomSuspendedSlot: (page: any, room: string, start: string) => Promise<boolean>;
  fillUnavailablePopup: (page: any, date: string, start: string, end: string) => Promise<boolean>;
  fillAvailablePopup: (page: any, date: string | null, start: string, end: string) => Promise<boolean>;
};

export function createKioskBlockFlowService(deps: CreateKioskBlockFlowServiceDeps) {
  const {
    log,
    delay,
    bookingUrl,
    roundUpToHalfHour,
    toClockMinutes,
    maskName,
    selectBookingDate,
    verifyBlockInGrid,
    clickRoomAvailableSlot,
    clickRoomSuspendedSlot,
    fillUnavailablePopup,
    fillAvailablePopup,
  } = deps;

  async function blockNaverSlot(page: any, entry: any) {
    const { name, date, start, end, room } = entry;
    log(`\n[Phase 3] 네이버 차단 시도: ${maskName(name)} ${date} ${start}~${end} ${room}`);

    async function capture(stage: string) {
      const safeStage = String(stage || 'stage').replace(/[^a-z0-9_-]+/gi, '-');
      const ssPath = `/tmp/naver-block-${date}-${safeStage}.png`;
      await page.screenshot({ path: ssPath, fullPage: false }).catch(() => null);
      log(`📸 [${safeStage}] 스크린샷: ${ssPath}`);
      return ssPath;
    }

    try {
      await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
      await delay(2000);
      await capture('calendar-open');

      const dateSelected = await selectBookingDate(page, date);
      if (!dateSelected) {
        log(`⚠️ 날짜 선택 실패: ${date}`);
        await capture('date-select-failed');
        return { ok: false, applied: false, reason: 'date_select_failed' };
      }
      await capture('date-selected');

      const endRounded = roundUpToHalfHour(end);
      if (endRounded !== end) log(`  종료시간 올림: ${end} → ${endRounded}`);
      const alreadyBlocked = await verifyBlockInGrid(page, room, start, endRounded);
      if (alreadyBlocked) {
        log('  ℹ️ 요청 구간이 이미 예약불가 상태입니다. 추가 차단 없이 성공 처리합니다.');
        await capture('already-blocked');
        return { ok: true, applied: false, reason: 'already_blocked' };
      }

      let selectedStart: string | null = null;
      let lastClickResult: any = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        lastClickResult = await clickRoomAvailableSlot(page, room, start);
        selectedStart = lastClickResult?.ok ? lastClickResult.selectedStart : null;
        if (selectedStart) {
          await capture(`slot-clicked-${attempt}`);
          break;
        }
        log(`⚠️ 예약가능 슬롯 클릭 실패 (시도 ${attempt}/2): room=${room}`);
        await capture(`slot-click-failed-${attempt}`);
        if (attempt < 2) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
          await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
          await delay(1500);
          const reselected = await selectBookingDate(page, date);
          log(`↻ 슬롯 클릭 재시도 전 날짜 재선택: ${reselected ? '성공' : '실패'}`);
          await capture(`slot-retry-ready-${attempt}`);
        }
      }

      if (!selectedStart) {
        if (lastClickResult?.looksAlreadyBlocked) {
          log('  ℹ️ 요청 구간 주변 슬롯이 모두 예약불가 상태라 false negative로 판단합니다. 성공 처리합니다.');
          await capture('already-blocked-false-negative');
          return { ok: true, applied: false, reason: 'already_blocked_false_negative' };
        }
        return { ok: false, applied: false, reason: 'slot_click_failed' };
      }
      if (selectedStart !== start) {
        log(`  시작시간 조정: ${start} → ${selectedStart} (종료시간 ${end} 유지)`);
      }

      const selectedStartMin = toClockMinutes(selectedStart);
      const requestedStartMin = toClockMinutes(start);
      const roundedEndMin = toClockMinutes(endRounded);
      if (
        selectedStartMin == null ||
        requestedStartMin == null ||
        roundedEndMin == null ||
        Math.abs(selectedStartMin - requestedStartMin) > 90 ||
        selectedStartMin >= roundedEndMin
      ) {
        log(`⚠️ 슬롯 안전장치 발동: 요청=${start} 선택=${selectedStart} 종료=${endRounded}`);
        await capture('slot-guard-blocked');
        return { ok: false, applied: false, reason: 'slot_guard_blocked' };
      }

      let done = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        done = await fillUnavailablePopup(page, date, selectedStart, endRounded);
        if (done) {
          await capture(`popup-applied-${attempt}`);
          break;
        }
        log(`⚠️ 예약불가 팝업 적용 실패 (시도 ${attempt}/2)`);
        await capture(`popup-failed-${attempt}`);
        if (attempt < 2) {
          const reopenedResult = await clickRoomAvailableSlot(page, room, selectedStart);
          const reopenedStart = reopenedResult?.ok ? reopenedResult.selectedStart : null;
          if (reopenedStart) {
            log(`↻ 팝업 재시도용 슬롯 재오픈 성공: ${reopenedStart}`);
            await capture(`popup-retry-ready-${attempt}`);
          } else {
            log('⚠️ 팝업 재시도용 슬롯 재오픈 실패');
          }
        }
      }
      if (!done) {
        return { ok: false, applied: false, reason: 'popup_apply_failed' };
      }

      await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
      await delay(1500);
      await capture('calendar-reloaded');
      const reselected = await selectBookingDate(page, date);
      if (!reselected) {
        log(`⚠️ 저장 후 날짜 재선택 실패: ${date}`);
        await capture('date-reselect-failed');
        return { ok: false, applied: true, reason: 'date_reselect_failed' };
      }
      await capture('date-reselected');

      const verified = await verifyBlockInGrid(page, room, selectedStart, endRounded);
      log(`  최종 확인: ${verified ? '✅ 차단 확인됨' : '❌ 차단 확인 실패'}`);
      await capture('verify-after-popup');
      if (!verified) {
        await capture('verify-failed');
        return { ok: false, applied: true, reason: 'verify_failed' };
      }
      return { ok: true, applied: true, reason: 'verified' };
    } catch (e: any) {
      log(`❌ 네이버 차단 중 오류: ${e.message}`);
      await capture('error');
      return { ok: false, applied: false, reason: 'exception', error: e.message };
    }
  }

  async function restoreAvailGoneSlot(page: any, room: string, start: string, endRounded: string) {
    const roomType = (room || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || room;
    const clicked = await page.evaluate((roomTypeArg: string) => {
      const pattern = new RegExp(`${roomTypeArg}(?:룸|\\s|$)`, 'i');
      let roomXRange: null | { left: number; right: number } = null;
      for (const el of Array.from(document.querySelectorAll('*')).filter((e: any) => {
        if ((e as HTMLElement).offsetParent === null || (e as HTMLElement).children.length > 0) return false;
        const r = (e as HTMLElement).getBoundingClientRect();
        return r.top >= 0 && r.top < 450 && r.width > 20;
      })) {
        const txt = ((el as HTMLElement).textContent || '').trim();
        if (pattern.test(txt) || txt === roomTypeArg) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (!roomXRange || r.left < roomXRange.left) roomXRange = { left: r.left, right: r.right };
        }
      }
      if (!roomXRange) return { found: false, reason: 'room column not found' };

      for (const btn of Array.from(document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]')).filter((b: any) => (b as HTMLElement).offsetParent !== null)) {
        const cls = String((btn as HTMLElement).className || '');
        if (!cls.includes('avail')) continue;
        const r = (btn as HTMLElement).getBoundingClientRect();
        const cx = r.left + r.width / 2;
        if (cx >= roomXRange.left - 20 && cx <= roomXRange.right + 20) {
          (btn as HTMLElement).click();
          return { found: true, btnTxt: ((btn as HTMLElement).textContent || '').trim(), cx: Math.round(cx) };
        }
      }
      return { found: false, reason: 'no avail button in room column' };
    }, roomType);

    log(`  패널 열기 (avail-gone 복구): ${JSON.stringify(clicked)}`);
    if (!clicked.found) {
      log(`  ⚠️ restoreAvailGoneSlot: ${room}룸 avail 버튼 없음 — 수동 복구 필요`);
      return false;
    }
    await delay(800);
    return fillAvailablePopup(page, null, start, endRounded);
  }

  async function unblockNaverSlot(page: any, entry: any) {
    const { name, date, start, end, room } = entry;
    log(`\n[Phase 3B] 네이버 차단 해제 시도: ${maskName(name)} ${date} ${start}~${end} ${room}`);

    try {
      await page.goto(bookingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
      await delay(2000);

      const dateSelected = await selectBookingDate(page, date);
      if (!dateSelected) {
        log(`⚠️ 날짜 선택 실패: ${date}`);
        const ssPath = `/tmp/naver-unblock-${date}-datesel.png`;
        await page.screenshot({ path: ssPath }).catch(() => null);
        log(`📸 스크린샷: ${ssPath}`);
        return false;
      }

      const isSuspended = await verifyBlockInGrid(page, room, start, end);
      if (!isSuspended) {
        const roomType = (room || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || room;
        const [hh2, mm2] = (start || '').split(':').map(Number);
        const dispH2 = hh2 > 12 ? hh2 - 12 : (hh2 === 0 ? 12 : hh2);
        const hourMin2 = `${dispH2}:${String(mm2).padStart(2, '0')}`;
        const isAvailGone = await page.evaluate((roomTypeArg: string, hourMinArg: string) => {
          let targetY: number | null = null;
          for (const el of document.querySelectorAll('[class*="Calendar__time"]')) {
            if (((el as HTMLElement).textContent || '').trim() === hourMinArg) {
              (el as HTMLElement).scrollIntoView({ block: 'center' });
              const r = (el as HTMLElement).getBoundingClientRect();
              targetY = r.top + r.height / 2;
              break;
            }
          }
          if (targetY === null) return null;
          let roomXRange: null | { left: number; right: number } = null;
          const pattern = new RegExp(`${roomTypeArg}(?:룸|\\s|$)`, 'i');
          for (const el of Array.from(document.querySelectorAll('*')).filter((e: any) => {
            if ((e as HTMLElement).offsetParent === null || (e as HTMLElement).children.length > 0) return false;
            const r = (e as HTMLElement).getBoundingClientRect();
            return r.top >= 0 && r.top < 450 && r.width > 20;
          })) {
            const txt = ((el as HTMLElement).textContent || '').trim();
            if (pattern.test(txt) || txt === roomTypeArg) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (!roomXRange || r.left < roomXRange.left) roomXRange = { left: r.left, right: r.right };
            }
          }
          if (!roomXRange) return null;
          for (const btn of Array.from(document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]')).filter((b: any) => (b as HTMLElement).offsetParent !== null)) {
            const cls = String((btn as HTMLElement).className || '');
            if (!cls.includes('avail')) continue;
            const r = (btn as HTMLElement).getBoundingClientRect();
            if (Math.abs((r.top + r.height / 2) - targetY) > 120) continue;
            const cx = r.left + r.width / 2;
            if (cx < roomXRange.left - 20 || cx > roomXRange.right + 20) continue;
            return false;
          }
          return true;
        }, roomType, hourMin2);

        if (isAvailGone !== true) {
          log('  ℹ️ 슬롯이 이미 예약가능 상태 (수동 해제됨). 상태만 업데이트.');
          return true;
        }

        log('  ⚠️ avail-gone 방식 차단 감지 → 같은 룸 다른 슬롯으로 패널 열어 예약가능 복구 시도');
        const endRoundedAG = roundUpToHalfHour(end);
        const doneAG = await restoreAvailGoneSlot(page, room, start, endRoundedAG);
        log(`  avail-gone 복구: ${doneAG ? '✅ 성공' : '❌ 실패 — 수동 확인 필요'}`);
        if (!doneAG) {
          await page.screenshot({ path: `/tmp/naver-unblock-${date}-availgone.png` }).catch(() => null);
        }
        return doneAG;
      }

      const slotClicked = await clickRoomSuspendedSlot(page, room, start);
      if (!slotClicked) {
        log(`⚠️ suspended 슬롯 클릭 실패: room=${room}`);
        const ssPath = `/tmp/naver-unblock-${date}-slot.png`;
        await page.screenshot({ path: ssPath }).catch(() => null);
        log(`📸 스크린샷: ${ssPath}`);
        return false;
      }

      const endRounded = roundUpToHalfHour(end);
      if (endRounded !== end) log(`  종료시간 올림: ${end} → ${endRounded}`);
      const done = await fillAvailablePopup(page, date, start, endRounded);
      if (!done) {
        const ssPath = `/tmp/naver-unblock-${date}-popup.png`;
        await page.screenshot({ path: ssPath }).catch(() => null);
        log(`📸 스크린샷: ${ssPath}`);
        return false;
      }

      const stillBlocked = await verifyBlockInGrid(page, room, start, end);
      const verified = !stillBlocked;
      log(`  최종 확인: ${verified ? '✅ 해제 확인됨' : '⚠️ 해제 확인 불가 (수동 확인 권장)'}`);
      if (!verified) {
        const ssPath = `/tmp/naver-unblock-${date}-verify.png`;
        await page.screenshot({ path: ssPath }).catch(() => null);
        log(`📸 최종 확인 스크린샷: ${ssPath}`);
      }
      return verified;
    } catch (err: any) {
      log(`❌ 네이버 차단 해제 중 오류: ${err.message}`);
      const ssPath = `/tmp/naver-unblock-${date}-error.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 스크린샷: ${ssPath}`);
      return false;
    }
  }

  return {
    blockNaverSlot,
    restoreAvailGoneSlot,
    unblockNaverSlot,
  };
}
