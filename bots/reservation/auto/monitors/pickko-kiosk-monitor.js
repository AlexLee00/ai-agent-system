#!/usr/bin/env node

/**
 * pickko-kiosk-monitor.js — 픽코 키오스크 예약 감지 → 네이버 예약 불가 처리
 *
 * 키오스크/전화 예약 = 픽코 이용금액 >= 1 (네이버 자동 등록은 0원 — 의도적 구분)
 * 신규 키오스크 예약 감지 시 → 네이버 booking calendar에서 해당 시간 차단
 * 스케줄: 30분 주기 (launchd: ai.ska.kiosk-monitor)
 *
 * 실행: node src/pickko-kiosk-monitor.js
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { publishToMainBot } = require('../../lib/mainbot-client');
const { createErrorTracker } = require('../../lib/error-tracker');
const { getKioskBlock, upsertKioskBlock, recordKioskBlockAttempt, getKioskBlocksForDate, pruneOldKioskBlocks } = require('../../lib/db');
const { maskPhone, maskName } = require('../../lib/formatting');
const { updateAgentState, acquirePickkoLock, releasePickkoLock, isPickkoLocked } = require('../../lib/state-bus');
const { getReservationKioskMonitorConfig } = require('../../lib/runtime-config');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const NAVER_ID = SECRETS.naver_id;
const NAVER_PW = SECRETS.naver_pw;

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
// naver-monitor.js가 저장하는 CDP 엔드포인트 파일 (새 탭 연결용)
const NAVER_WS_FILE = path.join(WORKSPACE, 'naver-monitor-ws.txt');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';
const KIOSK_MONITOR_RUNTIME = getReservationKioskMonitorConfig();

// ─── 유틸 ───────────────────────────────────────────────

function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function nowKST() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}


function fmtPhone(raw) {
  if ((raw || '').length === 11) return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`;
  return raw || '';
}

function publishRetryableBlockAlert(entry, reason, options = {}) {
  const {
    prefix = '⚠️',
    title = '네이버 차단 지연',
    roomSuffix = '룸',
    alertLevel = 2,
    sourceLabel = '키오스크 예약',
    actionLine = '자동 재시도 예정 — kiosk-monitor 후속 사이클을 확인하고, 계속 실패하면 수동 처리'
  } = options;

  const name = entry?.name || '(이름없음)';
  const phone = entry?.phoneRaw ? ` ${fmtPhone(entry.phoneRaw)}` : '';
  const date = entry?.date || '';
  const start = entry?.start || '';
  const end = entry?.end || '';
  const room = entry?.room || '';

  publishToMainBot({
    from_bot: 'jimmy',
    event_type: 'alert',
    alert_level: alertLevel,
    message:
      `${prefix} ${title}\n${name}${phone}\n${date} ${start}~${end} ${room}${roomSuffix}\n사유: ${reason}\n조치: ${actionLine} (${sourceLabel})`,
  });
}

function publishKioskSuccessReport(message) {
  publishToMainBot({
    from_bot: 'jimmy',
    event_type: 'report',
    alert_level: 1,
    message,
  });
}

async function journalBlockAttempt(entry, result, reason, options = {}) {
  await recordKioskBlockAttempt(entry.phoneRaw, entry.date, entry.start, {
    name: entry.name,
    date: entry.date,
    start: entry.start,
    end: entry.end,
    room: entry.room,
    amount: entry.amount || 0,
    naverBlocked: options.naverBlocked,
    blockedAt: options.blockedAt,
    naverUnblockedAt: options.naverUnblockedAt,
    lastBlockAttemptAt: options.at || nowKST(),
    lastBlockResult: result,
    lastBlockReason: reason,
    incrementRetry: options.incrementRetry === true,
  });
}

// 네이버 드롭다운은 30분 단위 — 종료시간을 30분 단위로 올림
// 예: "19:50" → "20:00", "19:30" → "19:30" (그대로)
function roundUpToHalfHour(timeStr) {
  const [h, m] = (timeStr || '').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return timeStr;
  if (m === 0 || m === 30) return timeStr; // 이미 30분 단위
  const newM = m < 30 ? 30 : 0;
  const newH = m >= 30 ? h + 1 : h;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

function toClockMinutes(timeStr) {
  const [h, m] = String(timeStr || '').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function to24Hour(timeText) {
  const text = (timeText || '').trim().replace(/\s+/g, ' ');
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
}



// ─── Phase 3: 네이버 booking calendar 로그인 ──────────

async function naverBookingLogin(page) {
  log('🔐 네이버 booking 로그인 시작...');

  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);

  // 이미 로그인된 경우 감지
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

  // 로그인 폼 감지
  const hasLoginForm = await page.$('input#id, input[name="id"], input#pw, input[name="pw"]');
  if (!hasLoginForm) {
    const currentUrl = page.url();
    log(`ℹ️ 로그인 폼 없음. URL: ${currentUrl.slice(0, 100)}`);
    // 네이버 ID 로그인 링크 클릭 시도
    const idLoginLink = await page.$('a[href*="id.naver.com"], a[href*="login"]');
    if (idLoginLink) {
      await idLoginLink.click();
      await delay(3000);
    }
  }

  // 아이디/비밀번호 입력
  await page.waitForSelector('input#id, input[name="id"]', { timeout: 10000 }).catch(() => null);
  const idEl = await page.$('input#id') || await page.$('input[name="id"]');
  const pwEl = await page.$('input#pw') || await page.$('input[name="pw"]');

  if (!idEl || !pwEl) {
    log('⚠️ 로그인 폼을 찾을 수 없음');
    return false;
  }

  await idEl.click({ clickCount: 3 });
  await page.type('input#id, input[name="id"]', NAVER_ID, { delay: 30 }).catch(() =>
    idEl.type(NAVER_ID, { delay: 30 })
  );
  await pwEl.click({ clickCount: 3 });
  await page.type('input#pw, input[name="pw"]', NAVER_PW, { delay: 30 }).catch(() =>
    pwEl.type(NAVER_PW, { delay: 30 })
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

  // 로그인 성공 확인
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

  // 2단계 보안 감지
  const secCheck = await page.evaluate(() => {
    const url = window.location.href;
    const text = document.body?.innerText || '';
    return {
      url: url.slice(0, 120),
      needsSecurity: /보안|인증|OTP|문자|전화|기기/.test(text)
    };
  });

  log(`⚠️ 로그인 후 상태: ${JSON.stringify(secCheck)}`);
  if (secCheck.needsSecurity) {
    publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 4, message: '🔐 네이버 예약관리 보안인증 필요!\n수동 로그인 후 재시작 필요' });
  }
  return false;
}

// ─── Phase 3: 날짜 이동 + 예약 불가 처리 ──────────────
//
// 절차:
// 1. DatePeriodCalendar__date-info 클릭 → 달력 팝업
// 2. > 버튼으로 월 이동 → 해당 날짜 클릭 (오늘="오늘", 나머지=숫자)
// 3. 적용 버튼 클릭
// 4. 시간 그리드에서 해당 룸의 예약가능 버튼 클릭
// 5. 팝업: 시작시간 드롭다운, 종료시간 드롭다운, 예약불가 선택, 설정변경 클릭

async function blockNaverSlot(page, entry) {
  const { name, phoneRaw, date, start, end, room } = entry;
  log(`\n[Phase 3] 네이버 차단 시도: ${maskName(name)} ${date} ${start}~${end} ${room}`);

  async function capture(stage) {
    const safeStage = String(stage || 'stage').replace(/[^a-z0-9_-]+/gi, '-');
    const ssPath = `/tmp/naver-block-${date}-${safeStage}.png`;
    await page.screenshot({ path: ssPath, fullPage: false }).catch(() => null);
    log(`📸 [${safeStage}] 스크린샷: ${ssPath}`);
    return ssPath;
  }

  try {
    // 예약 캘린더 페이지로 이동
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
    await delay(2000);
    await capture('calendar-open');

    // Step 2~3: 날짜 선택 + 적용
    const dateSelected = await selectBookingDate(page, date);
    if (!dateSelected) {
      log(`⚠️ 날짜 선택 실패: ${date}`);
      await capture('date-select-failed');
      return { ok: false, applied: false, reason: 'date_select_failed' };
    }
    await capture('date-selected');

    // Step 4: 해당 룸의 예약가능 버튼 클릭
    const endRounded = roundUpToHalfHour(end);
    if (endRounded !== end) log(`  종료시간 올림: ${end} → ${endRounded}`);
    const alreadyBlocked = await verifyBlockInGrid(page, room, start, endRounded);
    if (alreadyBlocked) {
      log('  ℹ️ 요청 구간이 이미 예약불가 상태입니다. 추가 차단 없이 성공 처리합니다.');
      await capture('already-blocked');
      return { ok: true, applied: false, reason: 'already_blocked' };
    }

    let selectedStart = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      selectedStart = await clickRoomAvailableSlot(page, room, start);
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
      return { ok: false, applied: false, reason: 'slot_click_failed' };
    }
    if (selectedStart !== start) {
      log(`  시작시간 조정: ${start} → ${selectedStart} (종료시간 ${end} 유지)`);
    }

    // Step 5~9: 팝업에서 시간/상태 설정 + 설정변경
    // 네이버 드롭다운은 30분 단위 — 종료시간 올림 (19:50 → 20:00)
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
        const reopenedStart = await clickRoomAvailableSlot(page, room, selectedStart);
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

    // 설정변경 후 같은 화면을 바로 믿지 않고 날짜를 다시 불러와 최종 상태를 확인한다.
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
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

    // Step 10: 시간박스에서 최종 확인 (요청 구간 전체 슬롯 확인)
    const verified = await verifyBlockInGrid(page, room, selectedStart, endRounded);
    log(`  최종 확인: ${verified ? '✅ 차단 확인됨' : '❌ 차단 확인 실패'}`);
    await capture('verify-after-popup');
    if (!verified) {
      await capture('verify-failed');
      return { ok: false, applied: true, reason: 'verify_failed' };
    }
    return { ok: true, applied: true, reason: 'verified' };

  } catch (e) {
    log(`❌ 네이버 차단 중 오류: ${e.message}`);
    await capture('error');
    return { ok: false, applied: false, reason: 'exception', error: e.message };
  }
}

// avail-gone 방식으로 차단된 슬롯 복구
// (같은 룸의 아무 avail 버튼으로 패널을 열어 해당 시간대를 예약가능으로 설정)
async function restoreAvailGoneSlot(page, room, start, endRounded) {
  const roomType = (room || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || room;

  // 같은 룸 컬럼 내 임의의 avail 버튼 클릭 → 패널 열기
  const clicked = await page.evaluate((roomType) => {
    const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
    let roomXRange = null;
    for (const el of Array.from(document.querySelectorAll('*')).filter(e => {
      if (!e.offsetParent || e.children.length > 0) return false;
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.top < 450 && r.width > 20;
    })) {
      const txt = (el.textContent || '').trim();
      if (pattern.test(txt) || txt === roomType) {
        const r = el.getBoundingClientRect();
        if (!roomXRange || r.left < roomXRange.left) roomXRange = { left: r.left, right: r.right };
      }
    }
    if (!roomXRange) return { found: false, reason: 'room column not found' };

    for (const btn of Array.from(document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]'))
        .filter(b => b.offsetParent !== null)) {
      const cls = btn.className || '';
      if (!cls.includes('avail')) continue;
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      if (cx >= roomXRange.left - 20 && cx <= roomXRange.right + 20) {
        btn.click();
        return { found: true, btnTxt: (btn.textContent || '').trim(), cx: Math.round(cx) };
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

// Phase 3B: 취소된 키오스크 예약의 네이버 예약불가 해제
async function unblockNaverSlot(page, entry) {
  const { name, phoneRaw, date, start, end, room } = entry;
  log(`\n[Phase 3B] 네이버 차단 해제 시도: ${maskName(name)} ${date} ${start}~${end} ${room}`);

  try {
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

    // 먼저 슬롯이 실제로 차단된 상태인지 확인 (suspended 버튼 또는 avail-gone 방식)
    const isSuspended = await verifyBlockInGrid(page, room, start, end);
    if (!isSuspended) {
      // avail-gone 방식 차단 여부 확인 (suspended 없이 avail 버튼도 없는 경우)
      const roomType2 = (room || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || room;
      const [hh2, mm2] = (start || '').split(':').map(Number);
      const dispH2 = hh2 > 12 ? hh2 - 12 : (hh2 === 0 ? 12 : hh2);
      const hourMin2 = `${dispH2}:${String(mm2).padStart(2, '0')}`;
      const isAvailGone = await page.evaluate((roomType, hourMin) => {
        let targetY = null;
        for (const el of document.querySelectorAll('[class*="Calendar__time"]')) {
          if ((el.textContent || '').trim() === hourMin) {
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            targetY = r.top + r.height / 2;
            break;
          }
        }
        if (targetY === null) return null;
        let roomXRange = null;
        const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
        for (const el of Array.from(document.querySelectorAll('*')).filter(e => {
          if (!e.offsetParent || e.children.length > 0) return false;
          const r = e.getBoundingClientRect();
          return r.top >= 0 && r.top < 450 && r.width > 20;
        })) {
          const txt = (el.textContent || '').trim();
          if (pattern.test(txt) || txt === roomType) {
            const r = el.getBoundingClientRect();
            if (!roomXRange || r.left < roomXRange.left) roomXRange = { left: r.left, right: r.right };
          }
        }
        if (!roomXRange) return null;
        for (const btn of Array.from(document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]')).filter(b => b.offsetParent !== null)) {
          const cls = btn.className || '';
          if (!cls.includes('avail')) continue;
          const r = btn.getBoundingClientRect();
          if (Math.abs((r.top + r.height / 2) - targetY) > 120) continue;
          const cx = r.left + r.width / 2;
          if (cx < roomXRange.left - 20 || cx > roomXRange.right + 20) continue;
          return false; // avail 버튼 있음 → 진짜 unblocked 상태
        }
        return true; // avail도 없음 → avail-gone 방식으로 차단된 상태
      }, roomType2, hourMin2);

      if (isAvailGone !== true) {
        log(`  ℹ️ 슬롯이 이미 예약가능 상태 (수동 해제됨). 상태만 업데이트.`);
        return true;
      }
      // avail-gone 방식 차단 확인 → 같은 룸의 다른 avail 버튼으로 패널 열어 복구
      log(`  ⚠️ avail-gone 방식 차단 감지 → 같은 룸 다른 슬롯으로 패널 열어 예약가능 복구 시도`);
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

    // 최종 확인 (suspended가 사라졌는지)
    const stillBlocked = await verifyBlockInGrid(page, room, start, end);
    const verified = !stillBlocked;
    log(`  최종 확인: ${verified ? '✅ 해제 확인됨' : '⚠️ 해제 확인 불가 (수동 확인 권장)'}`);
    if (!verified) {
      const ssPath = `/tmp/naver-unblock-${date}-verify.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 최종 확인 스크린샷: ${ssPath}`);
    }
    return true;

  } catch (err) {
    log(`❌ 네이버 차단 해제 중 오류: ${err.message}`);
    const ssPath = `/tmp/naver-unblock-${date}-error.png`;
    await page.screenshot({ path: ssPath }).catch(() => null);
    log(`📸 스크린샷: ${ssPath}`);
    return false;
  }
}

// Step 2~3: DatePeriodCalendar 달력 팝업 → 월 헤더 위치 기반 날짜 셀 클릭 → 적용
// 팝업은 입력창 없이 2개월 달력으로 표시됨 (예: 2026.2 / 2026.3)
// month header("2026.3")의 bounding rect으로 해당 월 영역을 특정 후 날짜 셀 클릭
async function selectBookingDate(page, date) {
  const today = getTodayKST();
  const isToday = date === today;
  const [yearStr, monthStr] = date.split('-');
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(date.split('-')[2]);
  const targetMonthKey = targetYear * 12 + targetMonth;
  const [todayYearStr, todayMonthStr] = getTodayKST().split('-');
  const currentMonthKey = parseInt(todayYearStr) * 12 + parseInt(todayMonthStr);
  // 헤더 텍스트 형식: "2026.3" (leading zero 없음)
  const headerText = `${targetYear}.${targetMonth}`;

  log(`  📅 날짜 선택: ${date} (헤더: "${headerText}")`);

  // [1단계] DatePeriodCalendar date-info 클릭 → 달력 팝업 열기
  const dateInfoSel = '[class*="DatePeriodCalendar__date-info"]';
  await page.waitForSelector(dateInfoSel, { timeout: 10000 });
  await page.click(dateInfoSel);
  await delay(1000);

  // [2단계] 목표 월 헤더 찾기 (최대 12번 >) — 없으면 > 버튼 클릭
  // 헤더 클래스: [class*="Calendar__monthly-top"] (예: Calendar__monthly-top__3+w3o)
  // 달력 컨테이너: [class*="DatePeriodCalendar__monthly"] — 이 안에서 날짜 셀 직접 탐색

  // 좌표 기반 클릭: evaluate로 좌표 추출 → page.mouse.click()으로 실제 클릭
  // (el.click() 대신 mouse event를 직접 발생시켜 React SPA 호환성 확보)
  let found = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    // 달력 컨테이너 내에서 해당 월 날짜 셀 좌표 추출
    const coords = await page.evaluate((headerText, targetDay, isToday) => {
      const dayStr = String(targetDay);

      // 날짜 텍스트 매칭 헬퍼: 오늘은 "오늘", "오늘대체공휴일..." 등으로 표시될 수 있음
      const matchDay = (txt) => {
        if (isToday && txt.startsWith('오늘')) return true;
        if (!txt.startsWith(dayStr)) return false;
        if (txt.length > dayStr.length && /\d/.test(txt[dayStr.length])) return false;
        return true;
      };

      // 1. DatePeriodCalendar__monthly 컨테이너들 중 headerText 월 헤더를 가진 것 찾기
      let targetContainer = null;
      for (const c of document.querySelectorAll('[class*="DatePeriodCalendar__monthly"]')) {
        const topEl = c.querySelector('[class*="Calendar__monthly-top"]');
        const topText = (topEl?.textContent || c.textContent || '').replace(/\s+/g, '');
        if (topText.includes(headerText.replace(/\s+/g, ''))) {
          targetContainer = c;
          break;
        }
      }

      if (!targetContainer) {
        return { found: false, reason: `container for "${headerText}" not found` };
      }

      // 2. 컨테이너 내에서 날짜 버튼 찾기 (button[class*="btn-day"] 우선)
      for (const btn of targetContainer.querySelectorAll('button[class*="btn-day"], button[class*="Calendar__btn"]')) {
        const txt = (btn.textContent || '').trim();
        if (!matchDay(txt)) continue;
        if (btn.getAttribute('aria-disabled') === 'true') continue;
        const r = btn.getBoundingClientRect();
        if (r.width <= 0) continue;
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, method: 'btn-day', txt: txt.slice(0, 10) };
      }

      // 3. TD/gridcell 폴백
      for (const cell of targetContainer.querySelectorAll('td, [role="gridcell"]')) {
        const txt = (cell.textContent || '').trim();
        if (!matchDay(txt)) continue;
        if (cell.getAttribute('aria-disabled') === 'true') continue;
        const cls = (cell.className || '').toLowerCase();
        if (cls.includes('disabled') || cls.includes('outside')) continue;
        const r = cell.getBoundingClientRect();
        if (r.width <= 0) continue;
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, method: 'td', txt: txt.slice(0, 10) };
      }
      return { found: false, reason: `day ${dayStr} not found in container`, isToday };
    }, headerText, targetDay, isToday);

    log(`  좌표 탐색 (attempt ${attempt + 1}): ${JSON.stringify(coords)}`);

    if (coords.found) {
      await page.mouse.click(coords.x, coords.y);
      log(`  ✅ 날짜 셀 mouse.click: (${Math.round(coords.x)}, ${Math.round(coords.y)})`);
      found = true;
      await delay(400);
      break;
    }

    // 목표 월이 안 보이면 picker 내 prev/next 버튼으로 이동
    const navCoords = await page.evaluate((targetMonthKey, currentMonthKey) => {
      const monthKey = (text) => {
        const m = String(text || '').trim().match(/^(\d{4})\.(\d{1,2})$/);
        if (!m) return null;
        return Number(m[1]) * 12 + Number(m[2]);
      };

      const monthlyContainers = Array.from(document.querySelectorAll('[class*="DatePeriodCalendar__monthly"]'))
        .filter((el) => el.offsetParent !== null);

      const headers = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.offsetParent === null) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\d{4}\.\d{1,2}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.width < 300 && r.height > 0 && r.height < 60;
      }).map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim(),
          key: monthKey(el.textContent || ''),
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
        };
      }).filter((h) => Number.isFinite(h.key)).sort((a, b) => a.left - b.left);

      const popupRoot = monthlyContainers.length > 0
        ? monthlyContainers[0].parentElement
        : null;

      if (headers.length === 0) {
        const prevBtn = popupRoot?.querySelector('button[class*="DatePeriodCalendar__prev"]');
        const nextBtn = popupRoot?.querySelector('button[class*="DatePeriodCalendar__next"]');
        const direction = targetMonthKey >= currentMonthKey ? 'next' : 'prev';
        const exactBtn = popupRoot?.querySelector(
          direction === 'next'
            ? 'button[class*="DatePeriodCalendar__next"]'
            : 'button[class*="DatePeriodCalendar__prev"]'
        );
        if (exactBtn && exactBtn.offsetParent !== null) {
          const r = exactBtn.getBoundingClientRect();
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
      const direction = targetMonthKey > maxKey ? 'next' : targetMonthKey < minKey ? 'prev' : 'next';
      const exactBtn = popupRoot?.querySelector(
        direction === 'next'
          ? 'button[class*="DatePeriodCalendar__next"]'
          : 'button[class*="DatePeriodCalendar__prev"]'
      );
      if (exactBtn && exactBtn.offsetParent !== null) {
        const r = exactBtn.getBoundingClientRect();
        return {
          found: true,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          direction,
          via: 'date-period-button',
          visibleMonths: headers.map((h) => h.text),
        };
      }

      return {
        found: false,
        reason: 'nav button not found',
        direction,
        visibleMonths: headers.map((h) => h.text),
      };
    }, targetMonthKey, currentMonthKey);

    log(`  → 달 이동 (attempt ${attempt + 1}): ${JSON.stringify(navCoords)}`);
    if (!navCoords.found) break;
    await page.mouse.click(navCoords.x, navCoords.y);
    await delay(800);
  }

  if (!found) {
    log(`  ❌ 날짜 선택 실패`);
    return false;
  }

  // [3단계] 적용 버튼 클릭
  const applyClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      if ((btn.textContent || '').trim() === '적용' && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  log(`  [3단계] 적용 버튼: ${applyClicked}`);
  if (!applyClicked) return false;

  await delay(2000); // 캘린더 뷰 갱신 대기
  return true;
}

async function isSettingsPanelVisible(page) {
  return page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => (b.textContent || '').trim().includes('설정변경') && b.offsetParent !== null);
  });
}

async function waitForSettingsPanelClosed(page, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const visible = await isSettingsPanelVisible(page);
    if (!visible) return true;
    await delay(250);
  }
  return false;
}

// Step 4: 해당 룸의 예약가능 버튼 클릭
// calendar-btn 클래스 + 좌표 기반으로 정확한 셀 클릭
async function clickRoomAvailableSlot(page, roomRaw, startTime) {
  // 룸 타입 추출: "스터디룸A1" → "A1", "스터디룸B" → "B"
  const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
  log(`  🏠 룸 슬롯 클릭: roomRaw="${roomRaw}" → roomType="${roomType}" time="${startTime}"`);

  // 24h "19:00" → 캘린더 표시 포맷 "오후 7:00"
  const [hh, mm] = (startTime || '09:00').split(':').map(Number);
  const isAM = hh < 12;
  const displayHour = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
  const ampm = isAM ? '오전' : '오후';
  const hourMin = `${displayHour}:${String(mm).padStart(2, '0')}`;   // "7:00"
  const timeDisplay = `${ampm} ${hourMin}`;                           // "오후 7:00"
  log(`  시간 표시: "${timeDisplay}"`);

  // 모든 로직을 단일 evaluate에서 수행 (scroll → getBoundingClientRect 일관성 유지)
  const result = await page.evaluate((roomType, timeDisplay, ampm, hourMin, startTimeArg) => {
    const isRenderable = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const isInViewport = (rect) => rect.bottom >= 0 && rect.top <= window.innerHeight;
    const to24HourLocal = (timeText) => {
      const text = String(timeText || '').trim().replace(/\s+/g, ' ');
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

    const visibleAxisMarkers = Array.from(document.querySelectorAll('*')).filter((el) => {
      if (el.children.length > 0) return false;
      if (!isRenderable(el)) return false;
      const rect = el.getBoundingClientRect();
      if (!isInViewport(rect)) return false;
      if (rect.left > 320) return false; // 좌측 시간축/행 라벨 영역
      const txt = (el.textContent || '').trim();
      return /^\d{1,2}:\d{2}$/.test(txt);
    }).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        el,
        raw: (el.textContent || '').trim(),
        y: rect.top + rect.height / 2,
        left: rect.left,
      };
    }).sort((a, b) => a.y - b.y);

    // 1. 먼저 현재 화면의 왼쪽 시간축에서 실제로 보이는 타임 라벨을 우선 찾는다.
    //    네이버 캘린더는 오프스크린 복제 노드가 섞여 있어, 보이는 시간축을 먼저 기준으로 잡아야 Y축이 안정적이다.
    let targetTimeEl = null;
    const visibleLeafTimeEls = visibleAxisMarkers
      .filter((marker) => marker.raw === hourMin)
      .map((marker) => marker.el);

    for (const el of visibleLeafTimeEls) {
      const parentText = (el.parentElement?.textContent || '').trim();
      if (parentText.includes(ampm)) {
        targetTimeEl = el;
        break;
      }
    }
    if (!targetTimeEl && visibleLeafTimeEls.length > 0) {
      targetTimeEl = visibleLeafTimeEls[0];
    }

    // 2. Calendar__time 스팬에서 대상 시간 요소 찾기
    //    오후 7:00: ampm스팬("오후") + time스팬("7:00") 구조
    const allTimeSpans = Array.from(document.querySelectorAll('[class*="Calendar__time"]'));
    const timeSpans = allTimeSpans.filter((span) => isRenderable(span));
    if (!targetTimeEl) {
      for (const span of timeSpans) {
        if ((span.textContent || '').trim() !== hourMin) continue;
        // 부모 또는 형제에 ampm 텍스트가 있는지 확인
        const parentText = (span.parentElement?.textContent || '').trim();
        if (parentText.includes(ampm)) {
          targetTimeEl = span;
          break;
        }
      }
    }
    // b) ampm 무시하고 hourMin 만으로 재시도
    if (!targetTimeEl) {
      for (const span of timeSpans) {
        if ((span.textContent || '').trim() === hourMin) {
          targetTimeEl = span;
          break;
        }
      }
    }
    // c) 최후 폴백: 모든 leaf 요소에서 hourMin 검색
    if (!targetTimeEl) {
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        if (!isRenderable(el)) continue;
        if ((el.textContent || '').trim() === hourMin) {
          targetTimeEl = el;
          break;
        }
      }
    }

    if (!targetTimeEl) {
      return { found: false, reason: `time element "${hourMin}" not found`, timeSpansCount: allTimeSpans.length };
    }

    // 2. 스크롤 후 Y 좌표 측정 (동일 evaluate 내에서 일관성 보장)
    targetTimeEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    const timeRect = targetTimeEl.getBoundingClientRect();
    const targetY = timeRect.top + timeRect.height / 2;

    // 3. 룸 컬럼 헤더 X 범위 구하기
    //    헤더는 페이지 상단 고정 영역 (viewport Y < 500)
    //    대상: roomType("A1") 포함 텍스트를 가진 가시 요소
    let roomXRange = null;
    const allVisible = Array.from(document.querySelectorAll('*')).filter(el => {
      if (!el.offsetParent) return false;
      if (el.children.length > 0) return false; // leaf only (text content)
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.top < 450 && rect.width > 20; // 상단 헤더 영역
    });
    for (const el of allVisible) {
      const text = (el.textContent || '').trim();
      // "A1룸" 또는 "A1" 포함, "A1" 로만 검색 시 A2룸 등 오매칭 방지
      // roomType이 "A1"이면 "A1룸" 또는 "A1 " 패턴 사용
      const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
      if (pattern.test(text) || text === roomType) {
        const rect = el.getBoundingClientRect();
        // 가장 왼쪽에 있는 첫 번째 match 선택 (기본룸 우선)
        if (!roomXRange || rect.left < roomXRange.left) {
          roomXRange = { left: rect.left, right: rect.right, cx: rect.left + rect.width / 2 };
        }
      }
    }

    // 4. calendar-btn 버튼 수집 (scrollIntoView 이후 화면에 나타난 것만)
    const calBtns = Array.from(document.querySelectorAll(
      '.calendar-btn, [class*="calendar-btn"], [class*="week-cell"] button, [class*="WeekCell"] button'
    )).filter((b) => {
      if (b.offsetParent === null) return false;
      const rect = b.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && isInViewport(rect);
    });

    if (calBtns.length === 0) {
      return { found: false, reason: 'no calendar-btn visible after scroll', targetY: Math.round(targetY), roomXRange };
    }

    const timeMarkers = [
      ...visibleAxisMarkers.map((marker) => ({ y: marker.y, raw: marker.raw })),
      ...timeSpans
        .filter((span) => isInViewport(span.getBoundingClientRect()))
        .map((span) => {
          const r = span.getBoundingClientRect();
          const raw = (span.parentElement?.textContent || span.textContent || '').replace(/\s+/g, ' ').trim();
          return { y: r.top + r.height / 2, raw };
        }),
    ];

    const btnInfos = calBtns.map(b => {
      const r = b.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const nearestTime = timeMarkers
        .slice()
        .sort((a, b) => Math.abs(a.y - cy) - Math.abs(b.y - cy))[0];
      return {
        el: b,
        cx: r.left + r.width / 2,
        cy,
        cls: b.className || '',
        text: (b.textContent || '').trim(),
        slotTime: nearestTime ? nearestTime.raw : null,
        slotTime24: nearestTime ? to24HourLocal(nearestTime.raw) : null,
      };
    });

    // 5. 룸 X 범위 필터
    let candidates = btnInfos;
    if (roomXRange) {
      const inRoom = candidates.filter(b => b.cx >= roomXRange.left - 15 && b.cx <= roomXRange.right + 15);
      if (inRoom.length > 0) candidates = inRoom;
    }

    // 6. block 경로에서는 예약가능(avail/remaining) 슬롯만 대상으로 본다.
    const availableCandidates = candidates.filter((b) => {
      const cls = String(b.cls || '');
      const text = String(b.text || '');
      const isSoldout = cls.includes('soldout') || cls.includes('disabled');
      const isBlocked = cls.includes('suspended') || cls.includes('btn-danger') || text.includes('예약불가');
      const isAvailable = cls.includes('avail') || cls.includes('btn-info') || text.includes('예약가능');
      return !isSoldout && !isBlocked && isAvailable;
    });
    const sameRowCandidates = availableCandidates.filter((b) => b.slotTime24 === startTimeArg);
    let finalCandidates = sameRowCandidates;
    if (finalCandidates.length === 0) {
      finalCandidates = availableCandidates.filter((b) => Math.abs(b.cy - targetY) <= 70);
    }
    if (finalCandidates.length === 0) {
      finalCandidates = availableCandidates;
    }

    if (finalCandidates.length === 0) {
      return {
        found: false, reason: 'no available button for target slot',
        btnsTotal: btnInfos.length,
        targetY: Math.round(targetY),
        roomXRange,
        roomCandidates: candidates.map((b) => ({
          cy: Math.round(b.cy),
          text: b.text,
          cls: String(b.cls || '').slice(0, 80),
          slotTime: b.slotTime || null,
          slotTime24: b.slotTime24 || null,
        })).slice(0, 12),
      };
    }

    // 7. 같은 행(exact row) 후보를 최우선으로 두고, 같은 행이 없으면 가장 가까운 행으로 후순위 정렬한다.
    const normalizedTarget = `${ampm}${hourMin}`;
    const orderedCandidates = finalCandidates
      .map(c => ({
        ...c,
        exact: String(c.slotTime || '').replace(/\s+/g, '') === normalizedTarget ? 0 : 1,
        timeDelta: (() => {
          const slot = to24HourLocal(c.slotTime);
          if (!slot) return Number.MAX_SAFE_INTEGER;
          const [slotH, slotM] = slot.split(':').map(Number);
          const [targetH, targetM] = String(startTimeArg || '00:00').split(':').map(Number);
          return Math.abs((slotH * 60 + slotM) - (targetH * 60 + targetM));
        })(),
        forward: c.cy >= targetY ? 0 : 1,
        diff: Math.abs(c.cy - targetY),
      }))
      .sort((a, b) => {
        if (a.exact !== b.exact) return a.exact - b.exact;
        if (a.timeDelta !== b.timeDelta) return a.timeDelta - b.timeDelta;
        if (a.forward !== b.forward) return a.forward - b.forward;
        if (a.diff !== b.diff) return a.diff - b.diff;
        return a.cy - b.cy;
      })
      .slice(0, 5);

    return {
      found: true, clicked: orderedCandidates.length > 0,
      btnText: orderedCandidates[0]?.text || '',
      btnClass: (orderedCandidates[0]?.cls || '').slice(0, 80),
      pos: orderedCandidates[0]
        ? { cx: Math.round(orderedCandidates[0].cx), cy: Math.round(orderedCandidates[0].cy) }
        : null,
      targetY: Math.round(targetY),
      roomXRange: roomXRange ? { l: Math.round(roomXRange.left), r: Math.round(roomXRange.right) } : null,
      btnsNearTime: btnInfos.filter(b => Math.abs(b.cy - targetY) <= 60).length,
      fallbackCandidates: orderedCandidates.map(c => ({
        cx: Math.round(c.cx),
        cy: Math.round(c.cy),
        text: c.text,
        cls: (c.cls || '').slice(0, 80),
        forward: c.forward === 0,
        slotTime: c.slotTime || null,
      })),
    };
  }, roomType, timeDisplay, ampm, hourMin, startTime);

  log(`  예약가능 버튼: ${JSON.stringify(result)}`);
  if (!result.found || !result.clicked) return false;

  const fallbacks = Array.isArray(result.fallbackCandidates) ? result.fallbackCandidates : [];
  for (let i = 0; i < fallbacks.length; i++) {
    const c = fallbacks[i];
    if (c.cx <= 0 || c.cy <= 0) continue;
    log(`  ↻ 슬롯 선택 시도 #${i + 1}: (${c.cx}, ${c.cy}) ${c.text}${c.forward ? ' [다음 슬롯 우선]' : ' [이전 슬롯]'}`);
    await page.mouse.click(c.cx, c.cy);
    await delay(1200);
    if (await isSettingsPanelVisible(page)) {
      const effectiveStart = to24Hour(c.slotTime) || startTime;
      log(`  ✅ 설정 패널 열림 확인 (시도 #${i + 1})${c.slotTime ? ` → 시작시간 ${effectiveStart}` : ''}`);
      return effectiveStart;
    }
  }

  log('  ❌ 후보 슬롯들을 순차 시도했지만 설정 패널이 열리지 않음');
  return null;
}

// Step 4 (해제용): 해당 룸의 suspended(예약불가) 버튼 클릭
async function clickRoomSuspendedSlot(page, roomRaw, startTime) {
  const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
  log(`  🏠 suspended 슬롯 클릭: roomRaw="${roomRaw}" → roomType="${roomType}" time="${startTime}"`);

  const [hh, mm] = (startTime || '09:00').split(':').map(Number);
  const isAM = hh < 12;
  const displayHour = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
  const ampm = isAM ? '오전' : '오후';
  const hourMin = `${displayHour}:${String(mm).padStart(2, '0')}`;
  const timeDisplay = `${ampm} ${hourMin}`;
  log(`  시간 표시: "${timeDisplay}"`);

  const result = await page.evaluate((roomType, timeDisplay, ampm, hourMin) => {
    // 1. 시간 Y 좌표 찾기 (clickRoomAvailableSlot과 동일)
    let targetTimeEl = null;
    const timeSpans = Array.from(document.querySelectorAll('[class*="Calendar__time"]'));
    for (const span of timeSpans) {
      if ((span.textContent || '').trim() !== hourMin) continue;
      const parentText = (span.parentElement?.textContent || '').trim();
      if (parentText.includes(ampm)) { targetTimeEl = span; break; }
    }
    if (!targetTimeEl) {
      for (const span of timeSpans) {
        if ((span.textContent || '').trim() === hourMin) { targetTimeEl = span; break; }
      }
    }
    if (!targetTimeEl) {
      for (const el of document.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        if ((el.textContent || '').trim() === hourMin) { targetTimeEl = el; break; }
      }
    }
    if (!targetTimeEl) return { found: false, reason: `time "${hourMin}" not found` };

    targetTimeEl.scrollIntoView({ block: 'center', inline: 'nearest' });
    const timeRect = targetTimeEl.getBoundingClientRect();
    const targetY = timeRect.top + timeRect.height / 2;

    // 2. 룸 컬럼 X 범위
    let roomXRange = null;
    const allVisible = Array.from(document.querySelectorAll('*')).filter(el => {
      if (!el.offsetParent) return false;
      if (el.children.length > 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.top < 450 && rect.width > 20;
    });
    for (const el of allVisible) {
      const text = (el.textContent || '').trim();
      const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
      if (pattern.test(text) || text === roomType) {
        const rect = el.getBoundingClientRect();
        if (!roomXRange || rect.left < roomXRange.left)
          roomXRange = { left: rect.left, right: rect.right, cx: rect.left + rect.width / 2 };
      }
    }

    // 3. calendar-btn 수집
    const calBtns = Array.from(document.querySelectorAll(
      '.calendar-btn, [class*="calendar-btn"], [class*="week-cell"] button, [class*="WeekCell"] button'
    )).filter(b => b.offsetParent !== null);
    if (calBtns.length === 0) return { found: false, reason: 'no calendar-btn visible', targetY: Math.round(targetY) };

    const btnInfos = calBtns.map(b => {
      const r = b.getBoundingClientRect();
      return { el: b, cx: r.left + r.width / 2, cy: r.top + r.height / 2, cls: b.className || '', text: (b.textContent || '').trim() };
    });

    // 4. Y 범위 필터
    let candidates = btnInfos.filter(b => Math.abs(b.cy - targetY) <= 25);
    if (candidates.length === 0) candidates = btnInfos.filter(b => Math.abs(b.cy - targetY) <= 60);
    if (candidates.length === 0) candidates = btnInfos;

    // 5. X 범위 필터
    if (roomXRange) {
      const inRoom = candidates.filter(b => b.cx >= roomXRange.left - 15 && b.cx <= roomXRange.right + 15);
      if (inRoom.length > 0) candidates = inRoom;
    }

    // 6. suspended(예약불가) 슬롯 우선 ← clickRoomAvailableSlot과의 핵심 차이
    const suspendedCandidates = candidates.filter(b => b.cls.includes('suspended') || b.cls.includes('btn-danger'));
    const finalCandidates = suspendedCandidates.length > 0 ? suspendedCandidates : candidates;

    if (finalCandidates.length === 0) {
      return { found: false, reason: 'no suitable button', btnsTotal: btnInfos.length, targetY: Math.round(targetY), roomXRange };
    }

    const best = finalCandidates.sort((a, b) => Math.abs(a.cy - targetY) - Math.abs(b.cy - targetY))[0];
    best.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    best.el.click();

    return {
      found: true, clicked: true,
      btnText: best.text, btnClass: best.cls.slice(0, 80),
      pos: { cx: Math.round(best.cx), cy: Math.round(best.cy) },
      targetY: Math.round(targetY),
      isSuspended: suspendedCandidates.length > 0
    };
  }, roomType, timeDisplay, ampm, hourMin);

  log(`  suspended 버튼: ${JSON.stringify(result)}`);
  if (!result.found || !result.clicked) return false;
  await delay(1500);
  return true;
}

// Step 5~9: 팝업에서 날짜 확인 + 시작/종료 시간 + 예약불가 + 설정변경
async function fillUnavailablePopup(page, date, start, end) {
  log(`  📋 팝업 설정: ${date} ${start}~${end} 예약불가`);

  // 패널(우측 예약정보 패널) 열림 확인 — "설정변경" 버튼 유무로 판단
  await delay(800);
  const popupVisible = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => (b.textContent || '').trim() === '설정변경' && b.offsetParent !== null);
  });
  log(`  패널 가시성(설정변경 버튼): ${popupVisible}`);

  // ── Step 5: 적용날짜 확인 (시작일 = 종료일 = date) ──
  // 날짜 인풋이 있으면 date로 맞추기 (이미 Step 2에서 선택했으므로 확인만)
  await page.evaluate((targetDate) => {
    const dateInputs = document.querySelectorAll('input[type="date"], input[placeholder*="날짜"], input[class*="date"]');
    dateInputs.forEach(el => {
      if (el.value !== targetDate) {
        el.value = targetDate;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }, date);

  // ── Step 6: 시작시간 드롭다운 선택 ──
  const startSet = await selectTimeDropdown(page, start, 'start');
  log(`  시작시간 설정: ${startSet}`);
  await delay(500);

  // ── Step 7: 종료시간 드롭다운 선택 ──
  const endSet = await selectTimeDropdown(page, end, 'end');
  log(`  종료시간 설정: ${endSet}`);
  await delay(500);

  // ── Step 8: 예약상태 → 예약불가 선택 ──
  const statusSet = await selectUnavailableStatus(page);
  log(`  예약불가 설정: ${statusSet}`);
  await delay(500);

  if (!statusSet) {
    log('  ⚠️ 예약불가 상태 설정 실패');
    return false;
  }

  // ── Step 9: 설정변경 버튼 클릭 ──
  const saved = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      const text = (btn.textContent || '').trim();
      if ((text === '설정변경' || text.includes('설정변경')) && btn.offsetParent !== null) {
        btn.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  log(`  설정변경 클릭: ${JSON.stringify(saved)}`);
  if (!saved.clicked) return false;

  const panelClosed = await waitForSettingsPanelClosed(page, 8000);
  if (!panelClosed) {
    log('  ⚠️ 설정 패널이 닫히지 않음 — 반영 실패 가능성');
    return false;
  }

  await delay(2500); // 설정변경 후 시간박스/캘린더 갱신 대기
  log('  ✅ 설정변경 완료 (패널 닫힘 확인)');
  return true;
}

// 시간 드롭다운 선택 헬퍼 (start 또는 end)
// 패널은 우측 고정 패널 (X > 1100) — bounding rect 기반으로 트리거 찾기
async function selectTimeDropdown(page, timeStr, which) {
  // timeStr: "18:00", "19:50" → 오후 표시: "오후 6:00", "오후 7:50"
  // 24:00(자정) → 네이버 드롭다운 텍스트 "자정 12:00"
  const [hh, mm] = timeStr.split(':').map(Number);
  const isMidnight = hh === 24 || (hh === 0 && mm === 0);
  const isAM = hh < 12;
  const displayH = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
  const ampm = isAM ? '오전' : '오후';
  const timeDisplay = isMidnight ? '자정 12:00' : `${ampm} ${displayH}:${String(mm).padStart(2, '0')}`;

  log(`    드롭다운(${which}): "${timeStr}" → "${timeDisplay}"`);

  // 1. native <select> 시도 (없을 가능성 높지만 빠른 확인)
  const nativeResult = await page.evaluate((timeStr) => {
    for (const sel of document.querySelectorAll('select')) {
      const r = sel.getBoundingClientRect();
      if (r.left < 1100) continue; // 패널 외 제외
      for (const opt of sel.options) {
        if (opt.value === timeStr || opt.text.trim() === timeStr) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { done: true, value: opt.value };
        }
      }
    }
    return { done: false };
  }, timeStr);
  if (nativeResult.done) { log(`    native: ${JSON.stringify(nativeResult)}`); return true; }

  // 2. 패널(X > 1100) 내 오전/오후 시간 텍스트 요소 찾기 → 클릭 (which=start=왼쪽, end=오른쪽)
  // BUTTON.form-control 우선 선택 — SPAN/DIV 부모 클릭 시 드롭다운이 열리지 않을 수 있음
  const triggerResult = await page.evaluate((which) => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (!timeRe.test(txt) || txt.length > 20) continue;
      candidates.push({ el, txt, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    if (candidates.length === 0) return { triggered: false, reason: 'no time text in panel', debug: [] };

    const debug = candidates.map(c => ({ tag: c.el.tagName, cls: (c.el.className||'').slice(0,60), txt: c.txt, x: Math.round(c.x), y: Math.round(c.y) }));

    // BUTTON 요소 우선 (custom-selectbox > BUTTON.form-control 패턴)
    const btnCandidates = candidates.filter(c => c.el.tagName === 'BUTTON');
    const sorted = (btnCandidates.length >= 2 ? btnCandidates : candidates).sort((a, b) => a.x - b.x);

    // start → 좌측(X 작은), end → 우측(X 큰) 요소 선택
    const target = which === 'start' ? sorted[0] : sorted[sorted.length - 1];
    target.el.click();
    return { triggered: true, txt: target.txt, tag: target.el.tagName, x: Math.round(target.x), debug };
  }, which);

  log(`    패널 트리거(${which}): ${JSON.stringify(triggerResult)}`);
  if (!triggerResult.triggered) return false;

  await delay(600);

  // 3. 열린 드롭다운에서 목표 시간 BUTTON.btn-select 클릭
  // 드롭다운 구조: LI.item > BUTTON.btn-select (텍스트 "오후 6:00" 형식)
  const optResult = await page.evaluate((timeDisplay, timeStr, ampm, displayH, mm) => {
    const minStr = String(mm).padStart(2, '0');
    const exact = timeDisplay;                    // "오후 6:00"
    const noSpace = `${ampm}${displayH}:${minStr}`; // "오후6:00"

    // 1. BUTTON.btn-select 우선 (정확 일치)
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (btn.textContent || '').trim();
      if (txt === exact || txt === noSpace) {
        btn.click();
        return { selected: true, txt, method: 'btn-select' };
      }
    }

    // 2. LI.item 정확 일치 (short text only)
    for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
      const r = li.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (li.textContent || '').trim();
      if (txt.length > 15) continue; // 전체 목록 텍스트 제외
      if (txt === exact || txt === noSpace) {
        li.click();
        return { selected: true, txt, method: 'li-item' };
      }
    }

    // 3. 넓은 탐색: 짧은 텍스트 + 오전/오후 패턴
    const pattern = new RegExp(`^${ampm}\\s*${displayH}:${minStr}$`);
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 12) continue;
      if (pattern.test(txt)) {
        el.click();
        return { selected: true, txt, method: 'broad' };
      }
    }
    return { selected: false };
  }, timeDisplay, timeStr, ampm, displayH, mm);

  log(`    드롭다운 옵션: ${JSON.stringify(optResult)}`);
  return optResult.selected;
}

// Step 5~9 (해제용): 팝업에서 날짜/시간 확인 + 예약가능 + 설정변경
async function fillAvailablePopup(page, date, start, end) {
  log(`  📋 팝업 설정: ${date} ${start}~${end} 예약가능`);

  await delay(800);
  const popupVisible = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.some(b => (b.textContent || '').trim() === '설정변경' && b.offsetParent !== null);
  });
  log(`  패널 가시성(설정변경 버튼): ${popupVisible}`);

  await page.evaluate((targetDate) => {
    const dateInputs = document.querySelectorAll('input[type="date"], input[placeholder*="날짜"], input[class*="date"]');
    dateInputs.forEach(el => {
      if (el.value !== targetDate) {
        el.value = targetDate;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }, date);

  const startSet = await selectTimeDropdown(page, start, 'start');
  log(`  시작시간 설정: ${startSet}`);
  await delay(500);

  const endSet = await selectTimeDropdown(page, end, 'end');
  log(`  종료시간 설정: ${endSet}`);
  await delay(500);

  const statusSet = await selectAvailableStatus(page);
  log(`  예약가능 설정: ${statusSet}`);
  await delay(500);

  if (!statusSet) {
    log('  ⚠️ 예약가능 상태 설정 실패');
    return false;
  }

  const saved = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      const text = (btn.textContent || '').trim();
      if ((text === '설정변경' || text.includes('설정변경')) && btn.offsetParent !== null) {
        btn.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  log(`  설정변경 클릭: ${JSON.stringify(saved)}`);
  if (!saved.clicked) return false;

  await delay(2500);
  log('  ✅ 설정변경 완료 (예약가능)');
  return true;
}

// 예약상태 드롭다운에서 "예약불가" 선택
// 패널(X > 1100) 내 "예약가능" 텍스트 요소 클릭 → "예약불가" 옵션 선택
async function selectUnavailableStatus(page) {
  // 1. native <select> 시도
  const nativeResult = await page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      const r = sel.getBoundingClientRect();
      if (r.left < 1100) continue;
      for (const opt of sel.options) {
        if (opt.text.includes('예약불가') || opt.value === 'unavailable') {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { done: true, text: opt.text };
        }
      }
    }
    return { done: false };
  });
  if (nativeResult.done) { log(`    native: ${JSON.stringify(nativeResult)}`); return true; }

  // 2. 예약상태 드롭다운 트리거 클릭
  // 패널 위치: X > 1100, Y > 200 (필터 탭 제외)
  // 상태 드롭다운은 "예약가능" 또는 "-" 텍스트로 표시
  // 시간 드롭다운(오전/오후 시간 패턴)과 구별
  const triggerResult = await page.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const statusTexts = ['예약가능', '예약 가능', '-'];

    // 1. BUTTON.form-control 중 시간 패턴 아닌 것 (상태 드롭다운)
    for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
      const r = btn.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (btn.textContent || '').trim();
      if (timeRe.test(txt)) continue; // 시간 드롭다운 제외
      if (statusTexts.includes(txt) || txt === '') {
        btn.click();
        return { triggered: true, txt, tag: btn.tagName, x: Math.round(r.left), y: Math.round(r.top), method: 'btn-form-control' };
      }
    }

    // 2. "예약상태" 라벨 인접 버튼 탐색
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt !== '예약상태') continue;
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200) continue;
      // 같은 행(Y ±40px) BUTTON.form-control
      const rowBtns = Array.from(document.querySelectorAll('button.form-control, button[class*="form-control"]'))
        .filter(b => {
          const br = b.getBoundingClientRect();
          return br.left > 1100 && Math.abs(br.top - r.top) < 40 && !timeRe.test((b.textContent || '').trim());
        });
      if (rowBtns.length > 0) {
        rowBtns[0].click();
        const br = rowBtns[0].getBoundingClientRect();
        return { triggered: true, txt: (rowBtns[0].textContent || '').trim(), method: 'label-adjacent', x: Math.round(br.left), y: Math.round(br.top) };
      }
    }

    // 3. 폴백: statusTexts 포함 모든 요소 (Y>200, 시간 패턴 제외)
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (timeRe.test(txt)) continue;
      if (statusTexts.includes(txt) || (txt.includes('예약가능') && txt.length < 15)) {
        el.click();
        return { triggered: true, txt, tag: el.tagName, x: Math.round(r.left), y: Math.round(r.top), method: 'fallback' };
      }
    }
    return { triggered: false };
  });

  log(`    예약상태 트리거: ${JSON.stringify(triggerResult)}`);
  if (!triggerResult.triggered) return false;

  await delay(600);

  // 3. 드롭다운에서 "예약불가" 옵션 선택
  // 반드시 패널 영역(X > 1100)에서만 찾아야 함 — 상단 필터 탭 "예약불가"(X<1000) 제외
  const optResult = await page.evaluate(() => {
    const UNAVAIL = ['예약불가', '예약 불가'];

    // 1. BUTTON.btn-select 우선 (드롭다운 옵션 버튼)
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (btn.textContent || '').trim();
      if (UNAVAIL.includes(txt)) {
        btn.click();
        return { selected: true, txt, method: 'btn-select', x: Math.round(r.left) };
      }
    }

    // 2. LI.item 중 X > 1100 (패널 드롭다운 목록)
    for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
      const r = li.getBoundingClientRect();
      if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
      const txt = (li.textContent || '').trim();
      if (UNAVAIL.includes(txt)) {
        li.click();
        return { selected: true, txt, method: 'li-item', x: Math.round(r.left) };
      }
    }

    // 3. 모든 요소 X > 1100 (패널 영역만)
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
      const txt = (el.textContent || '').trim();
      if (UNAVAIL.includes(txt)) {
        el.click();
        return { selected: true, txt, x: Math.round(r.left), y: Math.round(r.top) };
      }
    }

    return { selected: false };
  });

  log(`    예약불가 옵션: ${JSON.stringify(optResult)}`);
  return optResult.selected;
}

// 예약상태 드롭다운에서 "예약가능" 선택 (예약불가 → 예약가능 전환)
// 패널(X > 1100) 내 "예약불가" 트리거 클릭 → "예약가능" 옵션 선택
async function selectAvailableStatus(page) {
  // 1. native <select> 시도
  const nativeResult = await page.evaluate(() => {
    for (const sel of document.querySelectorAll('select')) {
      const r = sel.getBoundingClientRect();
      if (r.left < 1100) continue;
      for (const opt of sel.options) {
        if (opt.text.includes('예약가능') || opt.value === 'available') {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { done: true, text: opt.text };
        }
      }
    }
    return { done: false };
  });
  if (nativeResult.done) { log(`    native: ${JSON.stringify(nativeResult)}`); return true; }

  // 2. 상태 드롭다운 트리거 클릭 (현재 "예약불가" 텍스트로 표시됨)
  const triggerResult = await page.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const unavailTexts = ['예약불가', '예약 불가'];

    for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
      const r = btn.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (btn.textContent || '').trim();
      if (timeRe.test(txt)) continue;
      if (unavailTexts.some(s => txt.includes(s))) {
        btn.click();
        return { triggered: true, txt, method: 'btn-form-control' };
      }
    }

    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt !== '예약상태') continue;
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200) continue;
      const timeRe2 = /오[전후]\s*\d{1,2}:\d{2}/;
      const rowBtns = Array.from(document.querySelectorAll('button.form-control, button[class*="form-control"]'))
        .filter(b => {
          const br = b.getBoundingClientRect();
          return br.left > 1100 && Math.abs(br.top - r.top) < 40 && !timeRe2.test((b.textContent || '').trim());
        });
      if (rowBtns.length > 0) {
        rowBtns[0].click();
        return { triggered: true, txt: (rowBtns[0].textContent || '').trim(), method: 'label-adjacent' };
      }
    }

    // 폴백: 패널 내 "예약불가" 포함 요소 클릭
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (/오[전후]/.test(txt)) continue;
      if (txt.includes('예약불가') && txt.length < 15) {
        el.click();
        return { triggered: true, txt, tag: el.tagName, method: 'fallback' };
      }
    }
    return { triggered: false };
  });

  log(`    예약가능 상태 트리거: ${JSON.stringify(triggerResult)}`);
  if (!triggerResult.triggered) return false;

  await delay(600);

  // 3. 드롭다운에서 "예약가능" 옵션 선택
  const optResult = await page.evaluate(() => {
    const AVAIL = ['예약가능', '예약 가능'];

    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (btn.textContent || '').trim();
      if (AVAIL.includes(txt)) {
        btn.click();
        return { selected: true, txt, method: 'btn-select' };
      }
    }

    for (const li of document.querySelectorAll('li.item, li[class*="item"]')) {
      const r = li.getBoundingClientRect();
      if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
      const txt = (li.textContent || '').trim();
      if (AVAIL.includes(txt)) {
        li.click();
        return { selected: true, txt, method: 'li-item' };
      }
    }

    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
      const txt = (el.textContent || '').trim();
      if (AVAIL.includes(txt)) {
        el.click();
        return { selected: true, txt, method: 'broad' };
      }
    }
    return { selected: false };
  });

  log(`    예약가능 옵션: ${JSON.stringify(optResult)}`);
  return optResult.selected;
}

// Step 10: 설정변경 후 시간박스에서 차단 확인
// 해당 룸 열 X 범위 + 시작시간 Y 범위에서 suspended(예약불가) 버튼 존재 여부 확인
async function verifyBlockInGrid(page, roomRaw, start, end) {
  const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
  log(`  🔍 차단 최종 확인: room=${roomType} ${start}~${end}`);

  function buildRequestedSlots(startTime, endTime) {
    const [sh, sm] = String(startTime || '').split(':').map(Number);
    const [eh, em] = String(endTime || '').split(':').map(Number);
    if ([sh, sm, eh, em].some(Number.isNaN)) return [];
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    const slots = [];
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

  const result = await page.evaluate((roomType, requestedSlots) => {
    function toDisplayToken(time24) {
      const [hh, mm] = String(time24 || '').split(':').map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
      const isAM = hh < 12;
      const dispH = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
      return {
        ampm: isAM ? '오전' : '오후',
        hourMin: `${dispH}:${String(mm).padStart(2, '0')}`,
      };
    }

    function addThirtyMinutes(time24) {
      const [hh, mm] = String(time24 || '').split(':').map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
      const total = hh * 60 + mm + 30;
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }

    function isRenderable(el) {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isInViewport(rect) {
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    }

    function findTargetY(time24) {
      const token = toDisplayToken(time24);
      if (!token) return null;
      const visibleAxisMarkers = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length > 0) return false;
        if (!isRenderable(el)) return false;
        const rect = el.getBoundingClientRect();
        if (!isInViewport(rect)) return false;
        if (rect.left > 320) return false;
        const txt = (el.textContent || '').trim();
        return /^\d{1,2}:\d{2}$/.test(txt);
      });
      for (const el of visibleAxisMarkers) {
        if ((el.textContent || '').trim() !== token.hourMin) continue;
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      }

      const allAxisMarkers = Array.from(document.querySelectorAll('*')).filter((el) => {
        if (el.children.length > 0) return false;
        if (!isRenderable(el)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.left > 320) return false;
        const txt = (el.textContent || '').trim();
        return /^\d{1,2}:\d{2}$/.test(txt);
      });
      for (const el of allAxisMarkers) {
        if ((el.textContent || '').trim() !== token.hourMin) continue;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = el.getBoundingClientRect();
        return rect.top + rect.height / 2;
      }

      let targetTimeEl = null;
      for (const el of document.querySelectorAll('[class*="Calendar__time"]')) {
        if ((el.textContent || '').trim() === token.hourMin) {
          const parentText = (el.parentElement?.textContent || '').trim();
          if (parentText.includes(token.ampm)) { targetTimeEl = el; break; }
        }
      }
      if (!targetTimeEl) {
        for (const el of document.querySelectorAll('[class*="Calendar__time"]')) {
          if ((el.textContent || '').trim() === token.hourMin) { targetTimeEl = el; break; }
        }
      }
      if (!targetTimeEl) return null;
      targetTimeEl.scrollIntoView({ block: 'center', inline: 'nearest' });
      const rect = targetTimeEl.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }

    function parseSlotState(btn) {
      const cls = String(btn.className || '');
      const title = String(btn.getAttribute('title') || '').trim();
      const txt = String(btn.textContent || '').trim().replace(/\s+/g, '');

      const isBlocked =
        cls.includes('suspended') ||
        cls.includes('btn-danger') ||
        title === '예약불가' ||
        txt.includes('예약불가');

      const isAvailable =
        cls.includes('avail') ||
        cls.includes('btn-info') ||
        title === '예약가능' ||
        txt.includes('예약가능');

      let state = 'unknown';
      if (isBlocked) state = 'blocked';
      else if (isAvailable) state = 'available';

      return {
        state,
        cls,
        title,
        txt,
      };
    }

    // 2. 룸 컬럼 X 범위 (헤더 영역 Y < 450)
    let roomXRange = null;
    const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
    for (const el of Array.from(document.querySelectorAll('*')).filter(e => {
      if (!e.offsetParent || e.children.length > 0) return false;
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.top < 450 && r.width > 20;
    })) {
      const txt = (el.textContent || '').trim();
      if (pattern.test(txt) || txt === roomType) {
        const r = el.getBoundingClientRect();
        if (!roomXRange || r.left < roomXRange.left)
          roomXRange = { left: r.left, right: r.right };
      }
    }

    const matchedSlots = [];
    const missingSlots = [];
    for (const slot of requestedSlots) {
      const targetY = findTargetY(slot);
      if (targetY === null) {
        missingSlots.push({ slot, reason: 'time_not_found' });
        continue;
      }

      const calBtns = Array.from(document.querySelectorAll(
        '.calendar-btn, [class*="calendar-btn"]'
      )).filter((b) => {
        if (b.offsetParent === null) return false;
        const rect = b.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && isInViewport(rect);
      });

      let foundSuspended = null;
      for (const btn of calBtns) {
        const slotState = parseSlotState(btn);
        if (slotState.state !== 'blocked') continue;
        const r = btn.getBoundingClientRect();
        if (Math.abs((r.top + r.height / 2) - targetY) > 40) continue;
        if (roomXRange) {
          const cx = r.left + r.width / 2;
          if (cx < roomXRange.left - 20 || cx > roomXRange.right + 20) continue;
        }
        const buttonKey = `${Math.round(r.left)}:${Math.round(r.top)}:${Math.round(r.width)}:${Math.round(r.height)}`;
        const cy = r.top + r.height / 2;
        const halfHeight = r.height / 2;
        const coversTargetSlot = Math.abs(cy - targetY) <= Math.max(40, halfHeight + 8);
        if (!coversTargetSlot) continue;
        foundSuspended = {
          slot,
          key: buttonKey,
          cls: slotState.cls.slice(0, 80),
          title: slotState.title,
          x: Math.round(r.left),
          y: Math.round(r.top),
          h: Math.round(r.height),
          txt: slotState.txt,
        };
        break;
      }
      if (foundSuspended) matchedSlots.push(foundSuspended);
      else missingSlots.push({ slot, reason: 'suspended_not_found' });
    }

    const reconciledMissingSlots = [];
    for (const missing of missingSlots) {
      const missingIndex = requestedSlots.indexOf(missing.slot);
      const prevSlot = requestedSlots[missingIndex - 1];
      const prevMatched = matchedSlots.find((slot) => slot.slot === prevSlot);
      const isTrailingContinuation =
        missingIndex === requestedSlots.length - 1 &&
        prevMatched &&
        addThirtyMinutes(prevMatched.slot) === missing.slot &&
        missing.reason === 'suspended_not_found';

      if (isTrailingContinuation) {
        matchedSlots.push({
          slot: missing.slot,
          key: `${prevMatched.key}:continued`,
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
      requestedSlots,
      matchedSlots,
      missingSlots: reconciledMissingSlots,
      roomXRange: roomXRange ? { l: Math.round(roomXRange.left), r: Math.round(roomXRange.right) } : null,
    };
  }, roomType, requestedSlots);

  log(`  확인 결과: ${JSON.stringify(result)}`);
  return result.verified;
}

// ─── 메인 ────────────────────────────────────────────

async function main() {
  const today = getTodayKST();
  log(`\n🔍 픽코 키오스크 모니터 시작: ${today}`);
  await updateAgentState('jimmy', 'running', `키오스크 모니터 ${today}`);

  // ── Phase 5 선처리: 만료 항목 정리 ──
  // 어제 날짜 이전만 삭제 (어제 예약이 오늘도 픽코에 표시될 수 있어 1일 여유)
  const _todayParts = today.split('-').map(Number);
  const _pruneDt = new Date(_todayParts[0], _todayParts[1] - 1, _todayParts[2]);
  _pruneDt.setDate(_pruneDt.getDate() - 1);
  const _pruneDate = `${_pruneDt.getFullYear()}-${String(_pruneDt.getMonth()+1).padStart(2,'0')}-${String(_pruneDt.getDate()).padStart(2,'0')}`;
  const pruned = await pruneOldKioskBlocks(_pruneDate);
  if (pruned > 0) log(`🧹 만료 항목 삭제: ${pruned}건 (${_pruneDate} 이전)`);

  let browser;
  let lockAcquired = false;
  try {
    const existingLock = await isPickkoLocked();
    if (existingLock.locked && existingLock.by === 'manual') {
      const expiresAt = existingLock.expiresAt instanceof Date
        ? existingLock.expiresAt.toISOString()
        : existingLock.expiresAt || null;
      log(`⏸️ manual 픽코 작업이 진행 중이므로 kiosk-monitor 이번 사이클 스킵 (expiresAt=${expiresAt || 'unknown'})`);
      await updateAgentState('jimmy', 'idle', 'manual_priority_lock');
      return;
    }

    // 픽코 단독접근 락 획득 (최대 5분)
    lockAcquired = await acquirePickkoLock('jimmy');
    if (!lockAcquired) {
      log('⚠️ 픽코 락 획득 실패 — 다른 에이전트가 사용 중. 이번 사이클 스킵');
      await updateAgentState('jimmy', 'idle');
      return;
    }
    log('🔒 픽코 락 획득 (jimmy)');

    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ── Phase 1: 픽코 로그인 ──
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 픽코 로그인 완료: ${page.url()}`);

    // ── Phase 1: 키오스크 예약 파싱 (이용금액>=1 → 키오스크/전화 예약만) ──
    log(`\n[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=결제완료`);
    const { entries: kioskEntries, fetchOk } = await fetchPickkoEntries(page, today, { minAmount: 1 });

    for (const e of kioskEntries) {
      log(`  • ${maskName(e.name)} ${maskPhone(e.phoneRaw)} | ${e.date} ${e.start}~${e.end} | ${e.room} | ${e.amount}원`);
    }

    // ── Phase 2: 신규 예약 감지 ──
    const _kioskFlags = await Promise.all(kioskEntries.map(e => getKioskBlock(e.phoneRaw, e.date, e.start, e.end, e.room)));
    const newEntries = kioskEntries.filter((_, i) => !_kioskFlags[i]);

    // ── Phase 2A: 미차단 재시도 대상 ──
    // 이전 주기에서 차단 실패(naverBlocked=false)한 항목 중 아직 종료 전인 것
    const _nowForRetry = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const _nowDateForRetry = `${_nowForRetry.getFullYear()}-${String(_nowForRetry.getMonth()+1).padStart(2,'0')}-${String(_nowForRetry.getDate()).padStart(2,'0')}`;
    const _nowMinForRetry = _nowForRetry.getHours() * 60 + _nowForRetry.getMinutes();
    // _kioskFlags 재사용 (위에서 이미 조회 완료 — getKioskBlock은 async이므로 filter 내 await 불가)
    const retryEntries = kioskEntries.filter((e, i) => {
      const saved = _kioskFlags[i];
      if (!saved) return false;              // 신규 → newEntries에서 처리
      if (saved.naverBlocked) return false;  // 이미 차단 완료
      if (saved.naverUnblockedAt) return false; // 해제된 항목
      // 예약 종료 전인 항목만 재시도
      const [_rEndH, _rEndM] = (e.end || '23:59').split(':').map(Number);
      const isExpired = e.date < _nowDateForRetry || (e.date === _nowDateForRetry && _nowMinForRetry >= _rEndH * 60 + _rEndM);
      return !isExpired;
    });

    // 차단 처리 대상 = 신규 + 미차단 재시도
    // manual/manual_retry 후속 차단은 manual-block-followup 레일에서 별도 관리한다.
    const toBlockEntries = [];
    const seenBlockKeys = new Set();
    for (const entry of [...newEntries, ...retryEntries]) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`;
      if (seenBlockKeys.has(key)) continue;
      seenBlockKeys.add(key);
      toBlockEntries.push(entry);
    }

    // ── Phase 2B: 취소 감지 (픽코 상태별 직접 조회) ──
    // 상태 필터는 중복 선택이 되지 않으므로 `취소`, `환불`을 각각 조회한 뒤 합친다.
    log('\n[Phase 2B] 픽코 취소/환불 예약 직접 조회');
    log(`[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=환불`);
    const { entries: refundedEntries } = await fetchPickkoEntries(page, today, { statusKeyword: '환불', minAmount: 1 });
    log(`[Pickko 조회] 이용일>=${today}, 이용금액>=1, 상태=취소`);
    const { entries: cancelledStatusEntries } = await fetchPickkoEntries(page, today, { statusKeyword: '취소', minAmount: 1 });
    const rawCancelledEntries = [...refundedEntries, ...cancelledStatusEntries];
    const dedupedCancelledEntries = [];
    const seenCancelledKeys = new Set();
    for (const entry of rawCancelledEntries) {
      const key = `${entry.phoneRaw}|${entry.date}|${entry.start}|${entry.end || ''}|${entry.room || ''}`;
      if (seenCancelledKeys.has(key)) continue;
      seenCancelledKeys.add(key);
      dedupedCancelledEntries.push(entry);
    }

    // naverBlocked=true로 실제 차단한 항목만 해제 시도
    // (DB에 없거나 naverBlocked !== true → 차단한 적 없음 → 해제 불필요)
    const _cancelledWithKey = dedupedCancelledEntries.map(e => ({ ...e, key: `${e.phoneRaw}|${e.date}|${e.start}|${e.end || ''}|${e.room || ''}` }));
    const _cancelledSaved = await Promise.all(_cancelledWithKey.map(e => getKioskBlock(e.phoneRaw, e.date, e.start, e.end, e.room)));
    const cancelledEntries = _cancelledWithKey.filter((e, i) => {
      const saved = _cancelledSaved[i];
      if (!saved || !saved.naverBlocked) return false; // 차단 이력 없음
      if (saved.naverUnblockedAt) return false; // 이미 해제 완료
      return true;
    });

    log(`\n🆕 신규 키오스크 예약: ${newEntries.length}건 / 🔁 차단 재시도: ${retryEntries.length}건 (전체 ${kioskEntries.length}건)`);
    log(`🗑 픽코 취소 감지: 환불 ${refundedEntries.length}건 / 취소 ${cancelledStatusEntries.length}건 / 합산 ${dedupedCancelledEntries.length}건 (처리 필요: ${cancelledEntries.length}건)`);

    if (toBlockEntries.length === 0 && cancelledEntries.length === 0) {
      log('✅ 신규 예약 없음, 재시도 없음, 취소 없음. 종료');
      return;
    }

    // ── Phase 3: 네이버 blocking (CDP — naver-monitor 브라우저 새 탭 사용) ──
    log('\n[Phase 3] 네이버 booking calendar — CDP 연결');

    // naver-monitor.js가 저장한 wsEndpoint 읽기
    let wsEndpoint = null;
    try { wsEndpoint = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch (e) {}

    if (!wsEndpoint) {
      log('⚠️ naver-monitor 브라우저 미실행 (WS 파일 없음). 수동 처리 필요.');
      for (const e of toBlockEntries) {
        await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
          ...e,
          naverBlocked: false,
          firstSeenAt: nowKST(),
          lastBlockAttemptAt: nowKST(),
          lastBlockResult: 'deferred',
          lastBlockReason: 'naver_monitor_unavailable',
        });
        await journalBlockAttempt(e, 'deferred', 'naver_monitor_unavailable', {
          naverBlocked: false,
          incrementRetry: true,
        });
        publishRetryableBlockAlert(e, 'naver-monitor 미실행', {
          title: '네이버 차단 지연',
          sourceLabel: '키오스크 예약',
        });
      }
      for (const e of cancelledEntries) {
        publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message:
          `⚠️ 네이버 차단 해제 필요 — 수동 처리\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 취소)\n사유: naver-monitor 미실행`
        });
      }
      return;
    }

    log(`📡 CDP 연결: ${wsEndpoint.slice(0, 60)}...`);

    let naverBrowser = null;
    let naverPg = null;
    try {
      // naver-monitor 브라우저에 CDP로 연결 (새 인스턴스 생성 없음)
      naverBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
      log('✅ CDP 연결 성공');

      // 새 탭 생성 헬퍼 (Frame detach 재시도 시 재사용)
      const createNaverPage = async () => {
        const pg = await naverBrowser.newPage();
        pg.setDefaultTimeout(30000);
        await pg.setViewport({ width: 1920, height: 1080 });
        return pg;
      };

      naverPg = await createNaverPage();
      log('  → 새 탭 오픈 (1920×1080)');

      // booking URL 접속 (naver-monitor와 동일 세션 → 이미 로그인 상태)
      const loggedIn = await naverBookingLogin(naverPg);

      if (!loggedIn) {
        log('❌ 네이버 booking 로그인 실패');
        for (const e of toBlockEntries) {
          await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
            ...e,
            naverBlocked: false,
            firstSeenAt: nowKST(),
            lastBlockAttemptAt: nowKST(),
            lastBlockResult: 'deferred',
            lastBlockReason: 'naver_login_failed',
          });
          await journalBlockAttempt(e, 'deferred', 'naver_login_failed', {
            naverBlocked: false,
            incrementRetry: true,
          });
          publishRetryableBlockAlert(e, '네이버 로그인 실패', {
            title: '네이버 차단 지연',
            sourceLabel: '키오스크 예약',
          });
        }
        for (const e of cancelledEntries) {
          publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message:
            `⚠️ 네이버 차단 해제 필요 — 수동 처리\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 취소)\n사유: 네이버 로그인 실패`
          });
        }
        return;
      }

      // 각 신규·재시도 예약 처리
      for (const e of toBlockEntries) {
        const key = `${e.phoneRaw}|${e.date}|${e.start}`;
        log(`\n처리 중: ${key}`);

        // ── [시간 경과 체크] 예약 종료 시각이 이미 지났으면 차단 불필요 ──
        const _nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const _nowDateStr = `${_nowKST.getFullYear()}-${String(_nowKST.getMonth()+1).padStart(2,'0')}-${String(_nowKST.getDate()).padStart(2,'0')}`;
        const _nowMin = _nowKST.getHours() * 60 + _nowKST.getMinutes();
        const [_endH, _endM] = (e.end || '23:59').split(':').map(Number);
        const _isTimeElapsed = e.date < _nowDateStr || (e.date === _nowDateStr && _nowMin >= _endH * 60 + _endM);

        if (_isTimeElapsed) {
          log(`  ⏰ [시간 경과] 네이버 차단 생략: ${e.date} ${e.end} 이미 종료됨`);
          const _now = nowKST();
          await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
            name: e.name, date: e.date, start: e.start, end: e.end,
            room: e.room, amount: e.amount,
            naverBlocked: false, firstSeenAt: _now, blockedAt: null,
            lastBlockAttemptAt: _now,
            lastBlockResult: 'skipped',
            lastBlockReason: 'time_elapsed',
          });
          publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 2, message:
            `⏰ 시간 경과 — 네이버 차단 생략\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''}\n예약 종료 시각이 지나 네이버 차단 불필요 (픽코에서 직접 확인)`
          });
          continue;
        }

        // Frame detach 시 새 탭으로 1회 재시도
        let blocked = false;
        let blockReason = 'verify_failed';
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const blockResult = await blockNaverSlot(naverPg, e);
            blocked = Boolean(blockResult?.ok);
            blockReason = blockResult?.reason || (blocked ? 'verified' : 'verify_failed');
            break;
          } catch (err) {
            if (err.message.includes('detached Frame') && attempt === 1) {
              log(`⚠️ Frame detach 감지 — 새 탭으로 재시도 (attempt ${attempt + 1}/2)`);
              try { await naverPg.close(); } catch {}
              naverPg = await createNaverPage();
              const reLoggedIn = await naverBookingLogin(naverPg);
              if (!reLoggedIn) { blocked = false; blockReason = 'naver_relogin_failed'; break; }
            } else {
              log(`❌ blockNaverSlot 오류: ${err.message}`);
              const ssPath = `/tmp/naver-block-${e.date}-fatal.png`;
              await naverPg.screenshot({ path: ssPath }).catch(() => null);
              blockReason = 'exception';
              break;
            }
          }
        }

        const now = nowKST();
        await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
          name:         e.name,
          date:         e.date,
          start:        e.start,
          end:          e.end,
          room:         e.room,
          amount:       e.amount,
          naverBlocked: blocked,
          firstSeenAt:  now,
          blockedAt:    blocked ? now : null,
          lastBlockAttemptAt: now,
          lastBlockResult: blocked ? 'blocked' : 'retryable_failure',
          lastBlockReason: blockReason,
        });

        // ── Phase 4: 텔레그램 알림 ──
        if (blocked) {
          publishKioskSuccessReport(
            `✅ 네이버 예약 차단 완료\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 예약)`
          );
        } else {
          await journalBlockAttempt(e, 'retryable_failure', blockReason, {
            naverBlocked: false,
            incrementRetry: true,
          });
          publishRetryableBlockAlert(e, `차단 실패(${blockReason})`, {
            title: '네이버 차단 미확인',
            sourceLabel: '키오스크 예약',
          });
        }
      }

      // ── Phase 3B: 취소 → 네이버 차단 해제 ──
      if (cancelledEntries.length > 0) {
        log(`\n[Phase 3B] 취소 예약 ${cancelledEntries.length}건 네이버 차단 해제 시작`);
        for (const e of cancelledEntries) {
          const { key } = e;
          log(`\n처리 중 (취소): ${key}`);

          let unblocked = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              unblocked = await unblockNaverSlot(naverPg, e);
              break;
            } catch (err) {
              if (err.message.includes('detached Frame') && attempt === 1) {
                log(`⚠️ Frame detach 감지 — 새 탭으로 재시도 (attempt ${attempt + 1}/2)`);
                try { await naverPg.close(); } catch {}
                naverPg = await createNaverPage();
                const reLoggedIn = await naverBookingLogin(naverPg);
                if (!reLoggedIn) { unblocked = false; break; }
              } else {
                log(`❌ unblockNaverSlot 오류: ${err.message}`);
                const ssPath = `/tmp/naver-unblock-${e.date}-fatal.png`;
                await naverPg.screenshot({ path: ssPath }).catch(() => null);
                break;
              }
            }
          }

          if (unblocked) {
            // naverBlocked: false + naverUnblockedAt 기록 (기존 DB 데이터 보존)
            const existing = await getKioskBlock(e.phoneRaw, e.date, e.start, e.end, e.room);
            await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
              ...(existing || {}), ...e, naverBlocked: false, naverUnblockedAt: nowKST()
            });
            publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 2, message:
              `✅ 네이버 예약불가 해제\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 취소)`
            });
          } else {
            // 실패 시 naverBlocked: true 유지 → 다음 주기에 재시도
            publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message:
              `⚠️ 네이버 차단 해제 실패 — 수동 처리 필요\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''}`
            });
          }
        }
      }

    } finally {
      // 탭만 닫기 — 브라우저(naver-monitor)는 종료하지 않음
      if (naverPg) { try { await naverPg.close(); } catch (e) {} }
      // disconnect(): CDP 세션 해제 (브라우저 프로세스 유지)
      if (naverBrowser) { try { naverBrowser.disconnect(); } catch (e) {} }
    }

    log('\n✅ 픽코 키오스크 모니터 완료');

  } finally {
    // 성공/조기리턴/오류 모든 경로에서 idle 전환 + 락 해제
    await updateAgentState('jimmy', 'idle');
    if (lockAcquired) {
      await releasePickkoLock('jimmy');
      log('🔓 픽코 락 해제 (jimmy)');
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

// ─── block-slot 단독 모드 (대리등록 후 네이버 차단 전용) ──────────────────
// pickko-register.js가 픽코 등록 완료 후 이 모드로 호출
// 사용: node pickko-kiosk-monitor.js --block-slot --date=2026-03-03 --start=10:00 --end=12:00 --room=A1 --phone=01012345678 --name=홍길동

async function blockSlotOnly(entry) {
  const { date, start, end, room, name = '고객', phoneRaw = '00000000000' } = entry;
  log(`\n🔒 [block-slot 모드] 네이버 차단: ${name} ${date} ${start}~${end} ${room}`);

  // CDP 엔드포인트 읽기
  let wsEndpoint = null;
  try { wsEndpoint = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch (e) {}
  if (!wsEndpoint) {
    log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 수동 차단 필요');
    await journalBlockAttempt(entry, 'deferred', 'naver_monitor_unavailable', {
      naverBlocked: false,
      incrementRetry: true,
    });
    publishRetryableBlockAlert(entry, 'naver-monitor 미실행', {
      prefix: '🟠',
      title: '[대리등록] 네이버 예약불가 처리 지연',
      roomSuffix: '룸',
      sourceLabel: '대리등록',
    });
    process.exit(1);
  }

  let naverBrowser = null;
  let naverPg = null;
  let exitCode = 1;
  try {
    naverBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    log('✅ CDP 연결 성공');

    const createPage = async () => {
      const pg = await naverBrowser.newPage();
      pg.setDefaultTimeout(30000);
      await pg.setViewport({ width: 1920, height: 1080 });
      return pg;
    };
    naverPg = await createPage();

    const loggedIn = await naverBookingLogin(naverPg);
    if (!loggedIn) {
      log('❌ 네이버 booking 로그인 실패');
      await journalBlockAttempt(entry, 'deferred', 'naver_login_failed', {
        naverBlocked: false,
        incrementRetry: true,
      });
      publishRetryableBlockAlert(entry, '네이버 로그인 실패', {
        prefix: '🟠',
        title: '[대리등록] 네이버 예약불가 처리 지연',
        roomSuffix: '룸',
        sourceLabel: '대리등록',
      });
      // exitCode = 1 (기본값), finally로 탭 닫기 후 종료
    } else {
      // blockNaverSlot 실행 (Frame detach 시 1회 재시도)
      let blocked = false;
      let blockResult = { ok: false, applied: false, reason: 'not_started' };
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          blockResult = await blockNaverSlot(naverPg, entry);
          blocked = Boolean(blockResult?.ok);
          break;
        } catch (err) {
          if (err.message.includes('detached Frame') && attempt === 1) {
            log(`⚠️ Frame detach 감지 — 새 탭으로 재시도`);
            try { await naverPg.close(); } catch {}
            naverPg = await createPage();
            const reLoggedIn = await naverBookingLogin(naverPg);
            if (!reLoggedIn) break;
          } else {
            log(`❌ blockNaverSlot 오류: ${err.message}`);
            break;
          }
        }
      }

      // kiosk_blocks DB에 기록 (중복 차단 방지 / 추적)
      await upsertKioskBlock(phoneRaw, date, start, {
        name, date, start, end, room, amount: 0,
        naverBlocked: blocked,
        firstSeenAt:  nowKST(),
        blockedAt:    blocked ? nowKST() : null,
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
        publishKioskSuccessReport(`✅ [대리등록] 네이버 예약불가 처리 완료\n${name} ${date} ${start}~${end} ${room}룸`);
      } else if (blockResult?.applied) {
        log(`⚠️ 네이버 차단 검증 불확실 — 화면 확인 권장`);
        await journalBlockAttempt(entry, 'uncertain', blockResult?.reason || 'applied_but_unverified', {
          naverBlocked: false,
        });
        publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 2, message: `⚠️ [대리등록] 네이버 차단 검증 불확실 — 화면 확인 권장\n${name} ${date} ${start}~${end} ${room}룸` });
        blocked = true;
      } else {
        log(`⚠️ 네이버 차단 미확인 — 자동 재시도 예정`);
        await journalBlockAttempt(entry, 'retryable_failure', blockResult?.reason || 'verify_failed', {
          naverBlocked: false,
          incrementRetry: true,
        });
        publishRetryableBlockAlert(entry, '차단 검증 실패', {
          prefix: '🟠',
          title: '[대리등록] 네이버 예약불가 처리 지연',
          roomSuffix: '룸',
          sourceLabel: '대리등록',
        });
      }
      exitCode = blocked ? 0 : 1;
    }
  } finally {
    // process.exit()는 finally를 건너뛰므로 반드시 finally에서 탭 닫기
    if (naverPg)     { try { await naverPg.close();    } catch {} }
    if (naverBrowser){ try { naverBrowser.disconnect(); } catch {} }
  }
  process.exit(exitCode);
}

// ─── 오늘 예약 검증 (--audit-today) ──────────────────────────────────────────
//
// 하루 1회 (08:30 KST) launchd로 실행:
//   - 픽코 예약 기준으로 네이버 예약불가 상태 전체 검증
//   - 픽코 예약 있는데 네이버 미차단 → 차단 처리
//   - DB 차단 항목인데 픽코 예약 없음(취소/삭제) → 예약가능으로 해제
//
// 사용: node src/pickko-kiosk-monitor.js --audit-today

async function auditToday(dateOverride = null) {
  const today = dateOverride || getTodayKST();
  log(`\n📋 [오늘 예약 검증] ${today} 시작`);

  // ── Step 1: 픽코에서 오늘 예약 조회 ──
  let pickkoEntries = [];
  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    const { entries } = await fetchPickkoEntries(page, today, { minAmount: 1 });
    pickkoEntries = entries;
    log(`  픽코 예약: ${pickkoEntries.length}건`);
    for (const e of pickkoEntries) {
      log(`    • ${maskName(e.name)} ${e.date} ${e.start}~${e.end} ${e.room}`);
    }
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }

  // ── Step 2: 네이버 CDP 연결 ──
  let wsEndpoint = null;
  try { wsEndpoint = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch {}
  if (!wsEndpoint) {
    log('⚠️ naver-monitor 미실행 — 검증 불가');
    publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [오늘 예약 검증] naver-monitor 미실행으로 검증 불가` });
    return;
  }

  let naverBrowser = null;
  let naverPg = null;
  const okList = [], blockedList = [], unblockedList = [], failedList = [];

  try {
    naverBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    log('✅ CDP 연결 성공');

    const createPage = async () => {
      const pg = await naverBrowser.newPage();
      pg.setDefaultTimeout(30000);
      await pg.setViewport({ width: 1920, height: 1080 });
      return pg;
    };
    naverPg = await createPage();

    const loggedIn = await naverBookingLogin(naverPg);
    if (!loggedIn) {
      log('❌ 네이버 로그인 실패');
      publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [오늘 예약 검증] 네이버 로그인 실패` });
      return;
    }

    // 오늘 날짜 선택 (초기 1회)
    await naverPg.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await naverPg.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
    await delay(2000);
    await selectBookingDate(naverPg, today);
    await delay(1000);

    // ── Step 3: 픽코 예약별 차단 상태 확인 + 누락 시 차단 ──
    log('\n[검증] 픽코 예약 → 네이버 차단 상태 확인');
    for (const e of pickkoEntries) {
      try {
        const isBlocked = await verifyBlockInGrid(naverPg, e.room, e.start, e.end);
        if (isBlocked) {
          log(`  ✅ 차단확인: ${e.room} ${e.start}~${e.end} (${maskName(e.name)})`);
          okList.push(e);
          // DB 동기화: 확인됐으면 naverBlocked=true 보장
          const existing = await getKioskBlock(e.phoneRaw, e.date, e.start, e.end, e.room);
          if (!existing || !existing.naverBlocked) {
            await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
              ...(existing || {}), ...e,
              naverBlocked: true,
              firstSeenAt: existing?.firstSeenAt || nowKST(),
              blockedAt: existing?.blockedAt || nowKST(),
            });
          }
        } else {
          log(`  ⚠️ 차단 누락: ${e.room} ${e.start}~${e.end} → 차단 시도`);
          let success = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              success = Boolean((await blockNaverSlot(naverPg, e))?.ok);
              break;
            } catch (err) {
              if (err.message.includes('detached Frame') && attempt === 1) {
                log('  ⚠️ Frame detach → 새 탭으로 재시도');
                try { await naverPg.close(); } catch {}
                naverPg = await createPage();
                const reLoggedIn = await naverBookingLogin(naverPg);
                if (!reLoggedIn) break;
              } else {
                log(`  ❌ blockNaverSlot 오류: ${err.message}`);
                break;
              }
            }
          }
          const existing = await getKioskBlock(e.phoneRaw, e.date, e.start, e.end, e.room);
          await upsertKioskBlock(e.phoneRaw, e.date, e.start, {
            ...(existing || {}), ...e,
            naverBlocked: success,
            firstSeenAt: existing?.firstSeenAt || nowKST(),
            blockedAt: success ? nowKST() : null,
          });
          if (success) {
            blockedList.push(e);
          } else {
            log(`  ❌ 차단 실패: ${e.room} ${e.start}~${e.end} — 수동 차단 필요`);
            failedList.push(e);
          }
        }
      } catch (err) {
        log(`  ❌ 검증 오류 (${e.room} ${e.start}): ${err.message}`);
      }
    }

    // ── Step 4: DB 차단 항목 중 픽코 예약 없는 것 해제 ──
    const dbBlocks = await getKioskBlocksForDate(today);
    const pickkoSet = new Set(pickkoEntries.map(e => `${e.phoneRaw}|${e.start}`));
    const orphans = dbBlocks.filter(b => !pickkoSet.has(`${b.phoneRaw}|${b.start}`));
    log(`\n[검증] DB 차단 항목: ${dbBlocks.length}건, 고아 항목: ${orphans.length}건`);

    for (const b of orphans) {
      log(`  🗑 고아 차단 해제: ${b.room} ${b.start}~${b.end}`);
      let unblocked = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          unblocked = await unblockNaverSlot(naverPg, b);
          break;
        } catch (err) {
          if (err.message.includes('detached Frame') && attempt === 1) {
            log('  ⚠️ Frame detach → 새 탭으로 재시도');
            try { await naverPg.close(); } catch {}
            naverPg = await createPage();
            const reLoggedIn = await naverBookingLogin(naverPg);
            if (!reLoggedIn) break;
          } else {
            log(`  ❌ unblockNaverSlot 오류: ${err.message}`);
            break;
          }
        }
      }
      if (unblocked) {
        const existing = await getKioskBlock(b.phoneRaw, b.date, b.start, b.end, b.room);
        await upsertKioskBlock(b.phoneRaw, b.date, b.start, {
          ...(existing || {}), ...b,
          naverBlocked: false,
          naverUnblockedAt: nowKST(),
        });
        unblockedList.push(b);
      }
    }

  } finally {
    if (naverPg)     { try { await naverPg.close(); } catch {} }
    if (naverBrowser){ try { naverBrowser.disconnect(); } catch {} }
  }

  // ── 결과 요약 보고 ──
  const msgParts = [`📋 [오늘 예약 검증] ${today} 완료`];
  msgParts.push(`✅ 차단확인: ${okList.length}건`);
  if (blockedList.length > 0) {
    msgParts.push(`🔒 차단추가: ${blockedList.length}건`);
    for (const e of blockedList) msgParts.push(`  - ${e.room} ${e.start}~${e.end} (${maskName(e.name)})`);
  }
  if (unblockedList.length > 0) {
    msgParts.push(`🔓 차단해제: ${unblockedList.length}건`);
    for (const e of unblockedList) msgParts.push(`  - ${e.room} ${e.start}~${e.end}`);
  }
  if (failedList.length > 0) {
    msgParts.push(`❌ 차단실패(수동필요): ${failedList.length}건`);
    for (const e of failedList) msgParts.push(`  - ${e.room} ${e.start}~${e.end} (${maskName(e.name)})`);
  }
  if (blockedList.length === 0 && unblockedList.length === 0 && okList.length === 0) {
    msgParts.push('오늘 예약 없음');
  } else if (blockedList.length === 0 && unblockedList.length === 0) {
    msgParts.push('이상 없음');
  }
  publishToMainBot({ from_bot: 'jimmy', event_type: 'report', alert_level: 1, message: msgParts.join('\n') });
  log(`\n✅ 오늘 예약 검증 완료 — 확인: ${okList.length}, 차단추가: ${blockedList.length}, 해제: ${unblockedList.length}, 실패: ${failedList.length}`);
}

// ─── 진입점 ──────────────────────────────────────────────────────────────────

const KIOSK_ARGS = process.argv.slice(2).reduce((acc, arg) => {
  const [k, v] = arg.replace(/^--/, '').split('=');
  acc[k] = v !== undefined ? v : true;
  return acc;
}, {});

const kioskErrorTracker = createErrorTracker({ label: 'kiosk-monitor', threshold: KIOSK_MONITOR_RUNTIME.errorTrackerThreshold, persist: true });

// ─── unblock-slot 단독 모드 (취소 후 네이버 해제 전용) ──────────────────
// pickko-cancel-cmd.js가 픽코 취소 완료 후 이 모드로 호출
// 사용: node pickko-kiosk-monitor.js --unblock-slot --date=2026-03-03 --start=10:00 --end=12:00 --room=A1 --phone=01012345678 --name=홍길동

async function unblockSlotOnly(entry) {
  const { date, start, end, room, name = '고객', phoneRaw = '00000000000' } = entry;
  log(`\n🔓 [unblock-slot 모드] 네이버 차단 해제: ${name} ${date} ${start}~${end} ${room}`);

  let wsEndpoint = null;
  try { wsEndpoint = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch (e) {}
  if (!wsEndpoint) {
    log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 수동 해제 필요');
    publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [취소] 네이버 해제 실패 — 수동 처리 필요\n${name} ${date} ${start}~${end} ${room}\n사유: naver-monitor 미실행` });
    process.exit(1);
  }

  let naverBrowser = null;
  let naverPg = null;
  let exitCode = 1;
  try {
    naverBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    log('✅ CDP 연결 성공');

    const createPage = async () => {
      const pg = await naverBrowser.newPage();
      pg.setDefaultTimeout(30000);
      await pg.setViewport({ width: 1920, height: 1080 });
      return pg;
    };
    naverPg = await createPage();

    const loggedIn = await naverBookingLogin(naverPg);
    if (!loggedIn) {
      log('❌ 네이버 booking 로그인 실패');
      publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [취소] 네이버 해제 실패 — 수동 처리 필요\n${name} ${date} ${start}~${end} ${room}\n사유: 네이버 로그인 실패` });
      // exitCode stays 1, falls through to finally
    } else {
      let unblocked = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          unblocked = await unblockNaverSlot(naverPg, entry);
          break;
        } catch (err) {
          if (err.message.includes('detached Frame') && attempt === 1) {
            log(`⚠️ Frame detach 감지 — 새 탭으로 재시도`);
            try { await naverPg.close(); } catch {}
            naverPg = await createPage();
            const reLoggedIn = await naverBookingLogin(naverPg);
            if (!reLoggedIn) break;
          } else {
            log(`❌ unblockNaverSlot 오류: ${err.message}`);
            break;
          }
        }
      }

      // DB 업데이트
      const existing = await getKioskBlock(phoneRaw, date, start, end, room);
      await upsertKioskBlock(phoneRaw, date, start, {
        ...(existing || {}), name, date, start, end, room,
        naverBlocked: false,
        naverUnblockedAt: unblocked ? nowKST() : (existing?.naverUnblockedAt || null),
      });

      if (unblocked) {
        log(`✅ 네이버 해제 완료: ${name} ${date} ${start}~${end} ${room}`);
        publishKioskSuccessReport(`✅ [취소] 네이버 예약가능 복구 완료\n${name} ${date} ${start}~${end} ${room}룸`);
      } else {
        log(`⚠️ 네이버 해제 실패 — 수동 확인 필요`);
        publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [취소] 네이버 예약가능 복구 실패 — 수동 확인 필요\n${name} ${date} ${start}~${end} ${room}룸` });
      }
      exitCode = unblocked ? 0 : 1;
    }
  } finally {
    // process.exit()는 finally를 건너뛰므로 반드시 finally에서 탭 닫기
    if (naverPg)     { try { await naverPg.close();        } catch {} }
    if (naverBrowser){ try { naverBrowser.disconnect();     } catch {} }
  }
  process.exit(exitCode);
}

async function verifyBlockStateInFreshPage(naverBrowser, entry, options = {}) {
  const { date, start, end, room } = entry;
  const { capturePrefix = null } = options;
  const verifyPage = await naverBrowser.newPage();
  try {
    verifyPage.setDefaultTimeout(30000);
    await verifyPage.setViewport({ width: 1920, height: 1080 });

    const capture = async (stage) => {
      if (!capturePrefix) return null;
      const safeStage = String(stage || 'stage').replace(/[^a-z0-9_-]+/gi, '-');
      const ssPath = `/tmp/${capturePrefix}-${date}-${safeStage}.png`;
      await verifyPage.screenshot({ path: ssPath, fullPage: false }).catch(() => null);
      log(`📸 [${safeStage}] 스크린샷: ${ssPath}`);
      return ssPath;
    };

    const verifyLoggedIn = await naverBookingLogin(verifyPage);
    if (!verifyLoggedIn) {
      await capture('login-failed');
      return false;
    }

    await verifyPage.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await verifyPage.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
    await delay(1200);
    await capture('calendar-open');
    const dateSelected = await selectBookingDate(verifyPage, date);
    if (!dateSelected) {
      log(`⚠️ 검증용 날짜 선택 실패: ${date}`);
      await capture('date-select-failed');
      return false;
    }
    await capture('date-selected');
    const verified = await verifyBlockInGrid(verifyPage, room, start, roundUpToHalfHour(end));
    await capture(verified ? 'verified' : 'verify-failed');
    return verified;
  } finally {
    try { await verifyPage.close(); } catch {}
  }
}

// ─── verify-slot 단독 모드 (네이버 상태 검증 전용, 변경 없음) ───────────────
// 사용: node pickko-kiosk-monitor.js --verify-slot --date=2026-03-03 --start=10:00 --end=12:00 --room=A1

async function verifySlotOnly(entry) {
  const { date, start, end, room, name = '고객' } = entry;
  log(`\n🔎 [verify-slot 모드] 네이버 상태 검증: ${name} ${date} ${start}~${end} ${room}`);

  let wsEndpoint = null;
  try { wsEndpoint = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim(); } catch (e) {}
  if (!wsEndpoint) {
    log('⚠️ naver-monitor 미실행 (WS 파일 없음) — 검증 불가');
    process.exit(1);
  }

  let naverBrowser = null;
  let exitCode = 1;
  try {
    naverBrowser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    log('✅ CDP 연결 성공');
    const verified = await verifyBlockStateInFreshPage(naverBrowser, entry, { capturePrefix: 'naver-verify' });
    log(`✅ [verify-slot 결과] ${verified ? '차단 확인됨' : '차단 확인 실패'}: ${date} ${start}~${end} ${room}`);
    exitCode = verified ? 0 : 1;
  } finally {
    if (naverBrowser) { try { naverBrowser.disconnect(); } catch {} }
  }

  process.exit(exitCode);
}

if (KIOSK_ARGS['block-slot']) {
  // 대리등록 후 네이버 차단 단독 모드
  blockSlotOnly({
    name:     KIOSK_ARGS.name  || '고객',
    phoneRaw: (KIOSK_ARGS.phone || '00000000000').replace(/-/g, ''),
    date:     KIOSK_ARGS.date,
    start:    KIOSK_ARGS.start,
    end:      KIOSK_ARGS.end,
    room:     KIOSK_ARGS.room,
  }).catch(err => {
    log(`❌ block-slot 오류: ${err.message}`);
    process.exit(1);
  });
} else if (KIOSK_ARGS['verify-slot']) {
  // 네이버 상태 검증 전용 모드 (변경 없음)
  verifySlotOnly({
    name: KIOSK_ARGS.name || '고객',
    date: KIOSK_ARGS.date,
    start: KIOSK_ARGS.start,
    end: KIOSK_ARGS.end,
    room: KIOSK_ARGS.room,
  }).catch(err => {
    log(`❌ verify-slot 오류: ${err.message}`);
    process.exit(1);
  });
} else if (KIOSK_ARGS['unblock-slot']) {
  // 취소 후 네이버 차단 해제 단독 모드
  unblockSlotOnly({
    name:     KIOSK_ARGS.name  || '고객',
    phoneRaw: (KIOSK_ARGS.phone || '00000000000').replace(/-/g, ''),
    date:     KIOSK_ARGS.date,
    start:    KIOSK_ARGS.start,
    end:      KIOSK_ARGS.end,
    room:     KIOSK_ARGS.room,
  }).catch(err => {
    log(`❌ unblock-slot 오류: ${err.message}`);
    process.exit(1);
  });
} else if (KIOSK_ARGS['audit-today'] || KIOSK_ARGS['audit-date']) {
  // 하루 1회(08:30 KST) 오늘 예약 검증 모드 (--audit-date=YYYY-MM-DD 로 특정 날짜 지정 가능)
  const auditDate = typeof KIOSK_ARGS['audit-date'] === 'string' ? KIOSK_ARGS['audit-date'] : null;
  auditToday(auditDate)
    .then(() => process.exit(0))
    .catch(async err => {
      log(`❌ audit-today 오류: ${err.message}`);
      publishToMainBot({ from_bot: 'jimmy', event_type: 'alert', alert_level: 3, message: `⚠️ [오늘 예약 검증] 실행 오류: ${err.message}` });
      process.exit(1);
    });
} else {
  main()
    .then(() => kioskErrorTracker.success())
    .catch(async err => {
      log(`❌ 치명 오류: ${err.message}`);
      await kioskErrorTracker.fail(err);
      process.exit(1);
    });
}
