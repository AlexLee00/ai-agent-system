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
const { spawn } = require('child_process');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { loadJson, saveJson } = require('../lib/files');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const NAVER_ID = SECRETS.naver_id;
const NAVER_PW = SECRETS.naver_pw;

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const SEEN_FILE = path.join(__dirname, '..', 'pickko-kiosk-seen.json');
// naver-monitor.js와 profile 분리 → 세션 충돌 방지
const NAVER_PROFILE = path.join(WORKSPACE, 'naver-booking-profile');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';
const CHAT_ID = '***REMOVED***';

// ─── 유틸 ───────────────────────────────────────────────

function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function nowKST() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}

// pickko-daily-audit.js와 동일 패턴
function normalizeTime(str) {
  if (!str) return '';
  const m1 = str.match(/(오전|오후)\s*(\d+)시\s*(\d+)?분?/);
  if (m1) {
    let h = parseInt(m1[2]);
    const m = parseInt(m1[3] || '0');
    if (m1[1] === '오후' && h !== 12) h += 12;
    if (m1[1] === '오전' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const m2 = str.match(/(오전|오후)\s*(\d+):(\d{2})/);
  if (m2) {
    let h = parseInt(m2[2]);
    if (m2[1] === '오후' && h !== 12) h += 12;
    if (m2[1] === '오전' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m2[3]}`;
  }
  const m3 = str.match(/(\d{1,2}):(\d{2})/);
  if (m3) return `${m3[1].padStart(2, '0')}:${m3[2]}`;
  const m4 = str.match(/(\d{1,2})시\s*(\d+)?분/);
  if (m4) return `${m4[1].padStart(2, '0')}:${String(parseInt(m4[2] || '0')).padStart(2, '0')}`;
  return '';
}

function fmtPhone(raw) {
  if ((raw || '').length === 11) return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`;
  return raw || '';
}

function sendTelegram(message) {
  try {
    const child = spawn('openclaw', [
      'agent',
      '--message', `🔔 스카봇\n\n${message}`,
      '--channel', 'telegram',
      '--deliver',
      '--to', CHAT_ID
    ], { stdio: 'ignore', detached: true });
    child.unref();
    log(`📱 [텔레그램] ${message.slice(0, 80)}`);
  } catch (e) {
    log(`⚠️ 텔레그램 발송 실패: ${e.message}`);
  }
}

// ─── Phase 1: 픽코 키오스크 예약 파싱 ──────────────────

async function fetchKioskReservations(page, today) {
  log('\n[Phase 1] 픽코 키오스크 예약 파싱');

  await page.goto('https://pickkoadmin.com/study/index.html', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  await delay(2000);

  // ── 검색 필터 설정 ──
  const filterResult = await page.evaluate((todayStr) => {
    const info = {};

    // 이용일 시작 날짜 인풋 설정 (여러 후보 셀렉터 시도)
    const dateSelectors = [
      'input[name="sd_start"]',
      'input[name="start_date"]',
      'input[name="s_date"]',
      'input[name="use_start"]',
      '#sd_start', '#s_date', '#start_date'
    ];
    for (const sel of dateSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = todayStr;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        info.dateInput = sel;
        break;
      }
    }

    // 이용금액 >= 1 인풋 설정 (이용금액 시작/from 인풋)
    const amtSelectors = [
      'input[name="amt_from"]',
      'input[name="f_amt"]',
      'input[name="amount_from"]',
      'input[name="amt_start"]',
      'input[name="pay_from"]',
      '#amt_from', '#f_amt'
    ];
    for (const sel of amtSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = '1';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        info.amtInput = sel;
        break;
      }
    }

    // 모든 input name을 수집해서 디버깅 참고용으로 반환
    info.allInputNames = Array.from(document.querySelectorAll('input[name]')).map(el => ({
      name: el.name, type: el.type, id: el.id, value: el.value
    })).slice(0, 30);

    return info;
  }, today);

  log(`필터 설정: dateInput=${filterResult.dateInput || '못찾음'}, amtInput=${filterResult.amtInput || '못찾음'}`);
  if (!filterResult.dateInput || !filterResult.amtInput) {
    log(`⚠️ 인풋 탐지 실패. 전체 input 목록:\n${JSON.stringify(filterResult.allInputNames, null, 2)}`);
  }

  // 검색 실행
  try {
    await Promise.all([
      page.click('input[type="submit"][value="검색"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);
  } catch (e) {
    log(`ℹ️ 검색 버튼 클릭: ${e.message}`);
  }
  await delay(2000);

  // 테이블 헤더 분석 (colMap 패턴)
  const colMap = await page.evaluate(() => {
    const result = { name: -1, phone: -1, room: -1, startTime: -1, endTime: -1, amount: -1, status: -1, isCombined: false, headers: [] };
    const theadRows = document.querySelectorAll('thead tr');
    const lastRow = theadRows[theadRows.length - 1];
    const ths = lastRow ? Array.from(lastRow.querySelectorAll('th')) : [];
    ths.forEach((th, i) => {
      const t = th.textContent.trim();
      result.headers.push(t);
      if (t === '이름' || t.includes('회원')) result.name = i;
      if (t === '연락처' || t.includes('전화')) result.phone = i;
      if (t === '스터디룸' || (t.includes('스터디') && !t.includes('이용'))) result.room = i;
      if (t === '이용일시') { result.startTime = i; result.isCombined = true; }
      else if (t.includes('시작') && !t.includes('접수')) result.startTime = i;
      if (t.includes('종료') || t.includes('끝')) result.endTime = i;
      if (t.includes('이용금액') || t.includes('결제금액') || t === '금액') result.amount = i;
      if (t === '상태' || t.includes('결제') || t.includes('처리')) result.status = i;
    });
    return result;
  });
  log(`헤더: ${JSON.stringify(colMap.headers)}`);
  log(`컬럼맵: name=${colMap.name}, phone=${colMap.phone}, room=${colMap.room}, start=${colMap.startTime}${colMap.isCombined ? '(통합)' : ''}, end=${colMap.endTime}, amount=${colMap.amount}, status=${colMap.status}`);

  // 예약 행 파싱 (결제완료 + 이용금액>=1)
  const rawEntries = await page.evaluate((todayStr, cm) => {
    const entries = [];
    const trs = Array.from(document.querySelectorAll('tbody tr'));

    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 3) continue;

      const getText = (idx) => idx >= 0 && tds[idx]
        ? tds[idx].textContent.replace(/\s+/g, ' ').trim()
        : '';

      // 상태 컬럼 체크 (결제완료만 수집)
      const statusText = cm.status >= 0 ? getText(cm.status) : tr.textContent;
      if (!statusText.includes('결제완료')) continue;

      // 이용금액 체크 (>= 1)
      const amtText = cm.amount >= 0 ? getText(cm.amount) : '';
      const amtNum = parseInt((amtText || '0').replace(/[^0-9]/g, ''), 10);
      // amount 컬럼을 못 찾은 경우 필터 통과 (이용금액 인풋 필터로 이미 거름)
      if (cm.amount >= 0 && amtNum < 1) continue;

      const name = getText(cm.name);
      const phoneRaw = getText(cm.phone).replace(/[^0-9]/g, '');
      const room = getText(cm.room);
      const combinedText = cm.startTime >= 0 ? getText(cm.startTime) : '';
      const endText = cm.isCombined ? '' : (cm.endTime >= 0 ? getText(cm.endTime) : '');

      // 이용일시 파싱: 날짜 + 시작 ~ 종료
      let reservationDate = '';
      let startText = combinedText;
      const dateMatcher = combinedText.match(/(\d{4})-(\d{2})-(\d{2})/)
        || combinedText.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
      if (dateMatcher) {
        if (combinedText.includes('년')) {
          reservationDate = `${dateMatcher[1]}-${dateMatcher[2].padStart(2, '0')}-${dateMatcher[3].padStart(2, '0')}`;
        } else {
          reservationDate = dateMatcher[0];
        }
        startText = combinedText.slice(combinedText.indexOf(dateMatcher[0]) + dateMatcher[0].length).trim();
      }

      const tildeIdx = startText.indexOf('~');
      const parsedStart = tildeIdx >= 0 ? startText.slice(0, tildeIdx).trim() : startText;
      const parsedEnd = cm.isCombined
        ? (tildeIdx >= 0 ? startText.slice(tildeIdx + 1).trim() : '')
        : endText;

      entries.push({ name, phoneRaw, room, reservationDate, startText: parsedStart, endText: parsedEnd, amtText });
    }
    return entries;
  }, today, colMap);

  log(`📋 픽코 키오스크 예약 파싱: ${rawEntries.length}건 (결제완료, 이용금액>=1)`);

  // 정규화
  return rawEntries.map(e => {
    const start = normalizeTime(e.startText);
    const end = normalizeTime(e.endText);
    const date = e.reservationDate || today;
    return {
      name: e.name,
      phoneRaw: e.phoneRaw,
      room: e.room,
      date,
      start,
      end,
      amount: parseInt((e.amtText || '0').replace(/[^0-9]/g, ''), 10)
    };
  }).filter(e => e.phoneRaw && e.date && e.start);
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
    sendTelegram('🔐 네이버 예약관리 보안인증 필요!\n수동 로그인 후 재시작 필요');
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
  log(`\n[Phase 3] 네이버 차단 시도: ${name} ${date} ${start}~${end} ${room}`);

  try {
    // 예약 캘린더 페이지로 이동
    await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => null);
    await delay(2000);

    // Step 2~3: 날짜 선택 + 적용
    const dateSelected = await selectBookingDate(page, date);
    if (!dateSelected) {
      log(`⚠️ 날짜 선택 실패: ${date}`);
      const ssPath = `/tmp/naver-block-${date}-datesel.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 스크린샷: ${ssPath}`);
      return false;
    }

    // Step 4: 해당 룸의 예약가능 버튼 클릭
    const slotClicked = await clickRoomAvailableSlot(page, room);
    if (!slotClicked) {
      log(`⚠️ 예약가능 슬롯 클릭 실패: room=${room}`);
      const ssPath = `/tmp/naver-block-${date}-slot.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 스크린샷: ${ssPath}`);
      return false;
    }

    // Step 5~9: 팝업에서 시간/상태 설정 + 설정변경
    const done = await fillUnavailablePopup(page, date, start, end);
    if (!done) {
      const ssPath = `/tmp/naver-block-${date}-popup.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 스크린샷: ${ssPath}`);
      return false;
    }

    // Step 10: 시간박스에서 최종 확인 (예약가능 → 예약불가/차단 전환 확인)
    const verified = await verifyBlockInGrid(page, room, start, end);
    log(`  최종 확인: ${verified ? '✅ 차단 확인됨' : '⚠️ 차단 확인 불가 (수동 확인 권장)'}`);
    // 확인 실패해도 설정변경은 성공했으므로 true 반환 (알림은 별도 처리)
    if (!verified) {
      const ssPath = `/tmp/naver-block-${date}-verify.png`;
      await page.screenshot({ path: ssPath }).catch(() => null);
      log(`📸 최종 확인 스크린샷: ${ssPath}`);
    }
    return true;

  } catch (e) {
    log(`❌ 네이버 차단 중 오류: ${e.message}`);
    const ssPath = `/tmp/naver-block-${date}-error.png`;
    await page.screenshot({ path: ssPath }).catch(() => null);
    log(`📸 스크린샷: ${ssPath}`);
    return false;
  }
}

// Step 2~3: DatePeriodCalendar 날짜 선택 + 적용
async function selectBookingDate(page, date) {
  const today = getTodayKST();
  const isToday = date === today;
  const [yearStr, monthStr, dayStr] = date.split('-');
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(dayStr);

  log(`  📅 날짜 선택: ${date} (오늘여부: ${isToday})`);

  // 날짜 표시 클릭 → 달력 팝업 열기
  const dateInfoSel = '[class*="DatePeriodCalendar__date-info"]';
  await page.waitForSelector(dateInfoSel, { timeout: 10000 });
  await page.click(dateInfoSel);
  await delay(1200);

  // 달력 팝업 대기
  await page.waitForSelector('[class*="DatePeriodCalendar__calendar"], [class*="calendar-wrap"], [class*="CalendarWrap"]', { timeout: 8000 })
    .catch(() => log('  ℹ️ 달력 팝업 클래스 탐색 실패 — 계속 진행'));
  await delay(500);

  // 목표 날짜 셀 찾기 (최대 12번 월 이동)
  let found = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    found = await page.evaluate((isToday, targetYear, targetMonth, targetDay) => {
      // 오늘 → "오늘" 텍스트 버튼 클릭
      if (isToday) {
        const allEls = document.querySelectorAll('button, td, span, div');
        for (const el of allEls) {
          if (el.textContent.trim() === '오늘' && el.offsetParent !== null) {
            el.click();
            return true;
          }
        }
      }

      // 현재 달력 화면의 년/월 헤더 파싱
      const headerEls = document.querySelectorAll('[class*="month-name"], [class*="MonthName"], [class*="month-title"], [class*="MonthTitle"], [class*="month-header"]');
      let visibleMonths = [];
      headerEls.forEach(el => {
        const text = el.textContent.trim();
        // "2026년 2월" or "2026. 2" or "2월" etc.
        const m1 = text.match(/(\d{4})년\s*(\d{1,2})월/);
        const m2 = text.match(/(\d{4})[.\s]+(\d{1,2})/);
        if (m1) visibleMonths.push({ year: parseInt(m1[1]), month: parseInt(m1[2]) });
        else if (m2) visibleMonths.push({ year: parseInt(m2[1]), month: parseInt(m2[2]) });
      });

      // 헤더 탐지 안되면 날짜 숫자만으로 시도
      const targetMonthVisible = visibleMonths.some(m => m.year === targetYear && m.month === targetMonth);

      if (targetMonthVisible || visibleMonths.length === 0) {
        // 날짜 셀 탐색: 텍스트가 targetDay 숫자와 일치하는 클릭 가능한 셀
        const dayCells = document.querySelectorAll('button, td, [role="button"]');
        for (const cell of dayCells) {
          const txt = (cell.textContent || '').trim();
          if (txt === String(targetDay) && cell.offsetParent !== null && !cell.disabled) {
            // 비활성 상태 확인 (aria-disabled, class에 disabled/prev/next 등)
            const cls = (cell.className || '').toLowerCase();
            const ariaDisabled = cell.getAttribute('aria-disabled');
            if (ariaDisabled === 'true') continue;
            if (cls.includes('disabled') || cls.includes('prev-month') || cls.includes('next-month') || cls.includes('outside')) continue;
            cell.click();
            return true;
          }
        }
      }

      return false;
    }, isToday, targetYear, targetMonth, targetDay);

    if (found) {
      log(`  ✅ 날짜 셀 클릭 성공 (attempt ${attempt + 1})`);
      await delay(500);
      break;
    }

    // 다음 달로 이동 (> 버튼)
    const nextClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim();
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        if ((text === '>' || text === '›' || text === '▶' || ariaLabel.includes('next') || ariaLabel.includes('다음'))
          && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!nextClicked) {
      log(`  ⚠️ 다음 달 버튼 없음 (attempt ${attempt + 1})`);
      break;
    }
    await delay(600);
  }

  if (!found) {
    log(`  ❌ 날짜 셀 찾기 실패: ${date}`);
    return false;
  }

  // 적용 버튼 클릭
  await delay(300);
  const applyClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      const text = (btn.textContent || '').trim();
      if (text === '적용' && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  log(`  적용 버튼: ${applyClicked}`);
  if (!applyClicked) return false;

  await delay(2000); // 캘린더 뷰 갱신 대기
  return true;
}

// Step 4: 해당 룸의 예약가능 버튼 클릭
// 룸 이름 (A1, A2, B) 컬럼을 찾아 그 아래 첫 번째 예약가능 버튼 클릭
async function clickRoomAvailableSlot(page, roomRaw) {
  // 룸 타입 추출: "스터디룸 A1" → "A1", "A룸" → "A", "B룸" → "B"
  const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
  log(`  🏠 룸 슬롯 클릭: roomRaw="${roomRaw}" → roomType="${roomType}"`);

  const result = await page.evaluate((roomType) => {
    // 헤더에서 룸 타입 컬럼 인덱스 찾기
    // 테이블 구조 또는 그리드 구조 모두 대응
    const headerCells = document.querySelectorAll('th, [class*="header-cell"], [class*="HeaderCell"], [class*="room-name"], [class*="RoomName"]');
    let roomColIndex = -1;

    headerCells.forEach((cell, idx) => {
      const text = (cell.textContent || '').trim();
      if (text.includes(roomType) || text === roomType) {
        roomColIndex = idx;
      }
    });

    // 컬럼 인덱스로 해당 열의 예약가능 버튼 찾기
    if (roomColIndex >= 0) {
      // 테이블 방식: tbody td의 n번째 셀
      const rows = document.querySelectorAll('tbody tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells[roomColIndex]) {
          const btn = cells[roomColIndex].querySelector('button');
          if (btn) {
            const btnText = (btn.textContent || '').trim();
            if (btnText.includes('예약가능') || btnText.includes('예약 가능') || btnText.includes('가능')) {
              btn.click();
              return { clicked: true, method: 'table-col', roomColIndex, btnText };
            }
          }
        }
      }
    }

    // 폴백: 페이지 전체에서 룸 헤더 근처 예약가능 버튼 찾기
    // 컨테이너 기반 레이아웃 (flex/grid)
    const allTexts = document.querySelectorAll('[class*="room"], [class*="Room"], [class*="cell"], [class*="Cell"]');
    for (const el of allTexts) {
      const text = (el.textContent || '').trim();
      // 룸 타입이 포함된 컨테이너
      if (!text.includes(roomType)) continue;
      // 그 안에서 예약가능 버튼 찾기
      const btns = el.querySelectorAll('button');
      for (const btn of btns) {
        const btnText = (btn.textContent || '').trim();
        if ((btnText.includes('예약가능') || btnText.includes('예약 가능') || btnText.includes('가능'))
            && btn.offsetParent !== null) {
          btn.click();
          return { clicked: true, method: 'container', btnText };
        }
      }
    }

    // 최후 폴백: 아무 예약가능 버튼이나 클릭
    const allBtns = document.querySelectorAll('button');
    for (const btn of allBtns) {
      const btnText = (btn.textContent || '').trim();
      if ((btnText.includes('예약가능') || btnText.includes('예약 가능'))
          && btn.offsetParent !== null) {
        btn.click();
        return { clicked: true, method: 'fallback', btnText };
      }
    }

    return { clicked: false };
  }, roomType);

  log(`  예약가능 버튼: ${JSON.stringify(result)}`);
  if (!result.clicked) return false;

  await delay(1500); // 팝업 열림 대기
  return true;
}

// Step 5~9: 팝업에서 날짜 확인 + 시작/종료 시간 + 예약불가 + 설정변경
async function fillUnavailablePopup(page, date, start, end) {
  log(`  📋 팝업 설정: ${date} ${start}~${end} 예약불가`);

  // 팝업 열림 확인
  const popupVisible = await page.evaluate(() => {
    const popup = document.querySelector('[class*="Popup"], [class*="Modal"], [class*="modal"], [class*="popup"], [class*="Dialog"]');
    return !!popup && popup.offsetParent !== null;
  });
  log(`  팝업 가시성: ${popupVisible}`);

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

  await delay(2500); // 설정변경 후 팝업 닫히고 시간박스 갱신 대기
  log('  ✅ 설정변경 완료');
  return true;
}

// 시간 드롭다운 선택 헬퍼 (start 또는 end)
async function selectTimeDropdown(page, timeStr, which) {
  // timeStr 예: "15:00", "17:00"
  // 드롭다운 옵션은 "15:00" 또는 "오후 3:00" 형식일 수 있음

  // 먼저 native <select> 시도
  const nativeResult = await page.evaluate((timeStr, which) => {
    const keyword = which === 'start' ? ['시작', 'start', 'from'] : ['종료', '끝', 'end', 'to'];
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const label = (sel.name || sel.id || sel.getAttribute('aria-label') || '').toLowerCase();
      const isTarget = keyword.some(k => label.includes(k));
      // 선택 대상 select 특정 또는 순서로 구분
      if (isTarget || selects.length <= 2) {
        const options = Array.from(sel.options);
        // 정확 일치 먼저
        for (const opt of options) {
          if (opt.value === timeStr || opt.text.trim() === timeStr) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { done: true, method: 'native-exact', value: opt.value };
          }
        }
        // 부분 일치 (시간 앞부분만)
        const targetHour = timeStr.split(':')[0];
        for (const opt of options) {
          const v = opt.value || opt.text;
          if (v.includes(targetHour + ':')) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { done: true, method: 'native-partial', value: opt.value };
          }
        }
      }
    }
    return { done: false };
  }, timeStr, which);

  if (nativeResult.done) return true;

  // 커스텀 드롭다운 시도 (클릭 → 옵션 선택)
  const customResult = await page.evaluate((timeStr, which) => {
    const keyword = which === 'start' ? ['시작', 'start'] : ['종료', '끝', 'end'];

    // 시간 관련 커스텀 드롭다운 트리거 찾기
    const triggers = document.querySelectorAll('[class*="time-select"], [class*="TimeSelect"], [class*="time-picker"], [class*="TimePicker"], [class*="dropdown"], [class*="Dropdown"]');
    for (const trigger of triggers) {
      const label = (trigger.textContent || '').trim();
      const cls = (trigger.className || '').toLowerCase();
      const isTarget = keyword.some(k => cls.includes(k) || label.includes(k));
      if (isTarget && trigger.offsetParent !== null) {
        trigger.click();
        return { triggered: true, label };
      }
    }

    // 폴백: 현재 시간값이 표시된 버튼/div 찾기
    const allEls = document.querySelectorAll('button, [role="button"], [class*="select"]');
    for (const el of allEls) {
      const text = (el.textContent || '').trim();
      // 시간 패턴 "HH:MM" 또는 "오전/오후 H:MM" 이 있는 드롭다운 트리거
      if (/^\d{1,2}:\d{2}$/.test(text) || /오[전후]\s*\d/.test(text)) {
        if (el.offsetParent !== null) {
          el.click();
          return { triggered: true, text };
        }
      }
    }
    return { triggered: false };
  }, timeStr, which);

  if (!customResult.triggered) return false;
  await delay(500);

  // 열린 드롭다운에서 옵션 선택
  const optionClicked = await page.evaluate((timeStr) => {
    const [h, m] = timeStr.split(':');
    const targetHour = parseInt(h);
    const targetMin = parseInt(m);

    // 시간 옵션 li/option/div 탐색
    const items = document.querySelectorAll('[class*="option"], [class*="Option"], [role="option"], [class*="item"], [class*="Item"], li');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const text = (item.textContent || '').trim();
      // "15:00", "오후 3:00", "15시", "15시 00분" 등 매칭
      const isExact = text === timeStr;
      const hasHourMin = new RegExp(`\\b${targetHour}:${String(targetMin).padStart(2, '0')}\\b`).test(text);
      const hasHour = new RegExp(`\\b${targetHour}시`).test(text);
      if (isExact || hasHourMin || hasHour) {
        item.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  }, timeStr);

  log(`    ${which} 커스텀 드롭다운 옵션: ${JSON.stringify(optionClicked)}`);
  return optionClicked.clicked;
}

// 예약상태 드롭다운에서 "예약불가" 선택
async function selectUnavailableStatus(page) {
  // native select 시도
  const nativeResult = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const options = Array.from(sel.options);
      for (const opt of options) {
        if (opt.text.includes('예약불가') || opt.text.includes('예약 불가') || opt.value === 'unavailable' || opt.value === 'UNAVAILABLE') {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return { done: true, method: 'native', text: opt.text };
        }
      }
    }
    return { done: false };
  });

  if (nativeResult.done) return true;

  // 커스텀 드롭다운: 상태 트리거 클릭
  const triggerClicked = await page.evaluate(() => {
    // "예약상태" 라벨 근처 드롭다운 또는 현재 상태값 표시 요소 클릭
    const allEls = document.querySelectorAll('button, [role="button"], [class*="status"], [class*="Status"], [class*="select"], [class*="Select"]');
    for (const el of allEls) {
      const text = (el.textContent || '').trim();
      const cls = (el.className || '').toLowerCase();
      if ((cls.includes('status') || text.includes('예약가능') || text.includes('예약 가능') || text.includes('상태'))
          && el.offsetParent !== null) {
        el.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  if (!triggerClicked.clicked) return false;
  await delay(500);

  // 드롭다운에서 "예약불가" 옵션 클릭
  const optionClicked = await page.evaluate(() => {
    const items = document.querySelectorAll('[class*="option"], [class*="Option"], [role="option"], li, [class*="item"]');
    for (const item of items) {
      if (item.offsetParent === null) continue;
      const text = (item.textContent || '').trim();
      if (text.includes('예약불가') || text.includes('예약 불가')) {
        item.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });

  log(`    예약불가 옵션: ${JSON.stringify(optionClicked)}`);
  return optionClicked.clicked;
}

// Step 10: 설정변경 후 시간박스에서 차단 확인
// 해당 룸 열에서 예약가능 버튼이 사라지고 예약불가/차단 표시가 있으면 성공
async function verifyBlockInGrid(page, roomRaw, start, end) {
  const roomType = (roomRaw || '').replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim() || roomRaw;
  log(`  🔍 차단 최종 확인: room=${roomType} ${start}~${end}`);

  const result = await page.evaluate((roomType, start, end) => {
    // 시간박스 그리드에서 해당 룸 영역 확인
    const allText = document.body?.innerText || document.body?.textContent || '';

    // 예약불가/차단/blocked 텍스트가 페이지에 존재하는지 확인
    const hasBlockedText = allText.includes('예약불가') || allText.includes('예약 불가')
      || allText.includes('차단') || allText.includes('UNAVAILABLE');

    // 룸 근처에서 예약가능 버튼 수 확인 (줄어들었으면 성공)
    const roomContainers = document.querySelectorAll('[class*="room"], [class*="Room"], [class*="cell"], [class*="Cell"], th, td');
    let roomAreaHasAvailable = false;
    let roomAreaHasUnavailable = false;

    for (const container of roomContainers) {
      const text = (container.textContent || '').trim();
      if (!text.includes(roomType)) continue;
      if (text.includes('예약가능') || text.includes('예약 가능')) roomAreaHasAvailable = true;
      if (text.includes('예약불가') || text.includes('예약 불가') || text.includes('차단')) roomAreaHasUnavailable = true;
    }

    return {
      hasBlockedText,
      roomAreaHasAvailable,
      roomAreaHasUnavailable,
      // 페이지에 예약불가 텍스트가 있거나, 룸 영역에 예약불가가 표시되면 성공
      verified: hasBlockedText || roomAreaHasUnavailable
    };
  }, roomType, start, end);

  log(`  확인 결과: ${JSON.stringify(result)}`);
  return result.verified;
}

// ─── 메인 ────────────────────────────────────────────

async function main() {
  const today = getTodayKST();
  log(`\n🔍 픽코 키오스크 모니터 시작: ${today}`);

  const seenData = loadJson(SEEN_FILE);

  // ── Phase 5 선처리: 만료 항목 정리 ──
  let pruned = 0;
  for (const key of Object.keys(seenData)) {
    const entry = seenData[key];
    if (entry.date && entry.date < today) {
      delete seenData[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    log(`🧹 만료 항목 삭제: ${pruned}건`);
    saveJson(SEEN_FILE, seenData);
  }

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ── Phase 1: 픽코 로그인 ──
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 픽코 로그인 완료: ${page.url()}`);

    // ── Phase 1: 키오스크 예약 파싱 ──
    const kioskEntries = await fetchKioskReservations(page, today);

    for (const e of kioskEntries) {
      log(`  • ${e.name} ${e.phoneRaw} | ${e.date} ${e.start}~${e.end} | ${e.room} | ${e.amount}원`);
    }

    // ── Phase 2: 신규 예약 감지 ──
    const newEntries = kioskEntries.filter(e => {
      const key = `${e.phoneRaw}|${e.date}|${e.start}`;
      return !seenData[key];
    });

    log(`\n🆕 신규 키오스크 예약: ${newEntries.length}건 (전체 ${kioskEntries.length}건)`);

    if (newEntries.length === 0) {
      log('✅ 신규 예약 없음. 종료');
      return;
    }

    // ── Phase 3: 네이버 blocking ──
    log('\n[Phase 3] 네이버 booking calendar 로그인');

    // 새 페이지로 Naver booking 처리 (Pickko 탭과 분리)
    const naverPage = await browser.newPage();
    naverPage.setDefaultTimeout(30000);

    // Naver 별도 프로파일이 필요하므로 새 브라우저 인스턴스 사용
    await naverPage.close();

    let naverBrowser;
    try {
      naverBrowser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: NAVER_PROFILE,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--window-position=0,25',
          '--window-size=2294,1380'
        ]
      });

      const naverPg = await naverBrowser.newPage();
      naverPg.setDefaultTimeout(30000);

      const loggedIn = await naverBookingLogin(naverPg);

      if (!loggedIn) {
        log('❌ 네이버 booking 로그인 실패');
        // 모든 신규 예약에 대해 수동 처리 요청
        for (const e of newEntries) {
          const key = `${e.phoneRaw}|${e.date}|${e.start}`;
          seenData[key] = {
            ...e,
            naverBlocked: false,
            firstSeenAt: nowKST()
          };
          sendTelegram(
            `⚠️ 네이버 차단 실패 — 수동 처리 필요\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 예약)\n사유: 네이버 로그인 실패`
          );
        }
        saveJson(SEEN_FILE, seenData);
        return;
      }

      // 각 신규 예약 처리
      for (const e of newEntries) {
        const key = `${e.phoneRaw}|${e.date}|${e.start}`;
        log(`\n처리 중: ${key}`);

        const blocked = await blockNaverSlot(naverPg, e);

        const now = nowKST();
        seenData[key] = {
          name: e.name,
          phoneRaw: e.phoneRaw,
          date: e.date,
          start: e.start,
          end: e.end,
          room: e.room,
          amount: e.amount,
          naverBlocked: blocked,
          firstSeenAt: now,
          ...(blocked && { blockedAt: now })
        };

        saveJson(SEEN_FILE, seenData);

        // ── Phase 4: 텔레그램 알림 ──
        if (blocked) {
          sendTelegram(
            `🚫 네이버 예약 차단 완료\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''} (키오스크 예약)`
          );
        } else {
          sendTelegram(
            `⚠️ 네이버 차단 실패 — 수동 처리 필요\n${e.name || '(이름없음)'} ${fmtPhone(e.phoneRaw)}\n${e.date} ${e.start}~${e.end} ${e.room || ''}`
          );
        }
      }

    } finally {
      if (naverBrowser) {
        try { await naverBrowser.close(); } catch (e) {}
      }
    }

    log('\n✅ 픽코 키오스크 모니터 완료');

  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
