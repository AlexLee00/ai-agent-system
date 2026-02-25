/**
 * test-block-intercept.js
 * 2026-03-02 B룸 18:00 예약불가 처리 + API 인터셉트 확인
 * - selectBookingDate → clickRoomAvailableSlot → fillUnavailablePopup → 설정변경
 * - PATCH /schedules body 캡처 → 날짜/시간 확인
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { delay, log } = require('./lib/utils');

const BIZE_ID = '596871';
const BOOKING_URL = `https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-calendar-view`;
const TARGET = { date: '2026-03-02', start: '18:00', end: '20:00', room: '스터디룸B' };

function roundUpToHalfHour(timeStr) {
  const [h, m] = (timeStr || '').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return timeStr;
  if (m === 0 || m === 30) return timeStr;
  const newM = m < 30 ? 30 : 0;
  const newH = m >= 30 ? h + 1 : h;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

(async () => {
  const wsFile = path.join(process.env.HOME, '.openclaw/workspace/naver-monitor-ws.txt');
  const ws = fs.readFileSync(wsFile, 'utf8').trim();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });

  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080 });

  // ── CDP Network 인터셉트 설정 ──
  const client = await pg.createCDPSession();
  await client.send('Network.enable');

  const patchCalls = [];
  client.on('Network.requestWillBeSent', (params) => {
    if (params.request.url.includes('/schedules') && params.request.method === 'PATCH') {
      console.log(`\n🔍 PATCH /schedules:`);
      console.log(`  URL: ${params.request.url}`);
      console.log(`  Body: ${params.request.postData || '(no body captured)'}`);
      patchCalls.push({ id: params.requestId, url: params.request.url, body: params.request.postData });
    }
  });

  client.on('Network.responseReceived', (params) => {
    const call = patchCalls.find(c => c.id === params.requestId);
    if (call) {
      call.status = params.response.status;
      call.statusText = params.response.statusText;
      console.log(`📨 HTTP 응답: ${params.response.status} ${params.response.statusText}`);
    }
  });

  client.on('Network.loadingFailed', (params) => {
    const call = patchCalls.find(c => c.id === params.requestId);
    if (call) {
      call.failed = params.errorText;
      console.log(`❌ 요청 실패: ${params.errorText}`);
    }
  });

  // ── 1. BOOKING_URL 접속 ──
  log('1. 예약 캘린더 접속');
  await pg.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  await delay(2000);

  // ── 2. 날짜 선택: 2026-03-02 ──
  log('2. 날짜 선택: 2026-03-02');
  const { date } = TARGET;
  const [yearStr, monthStr] = date.split('-');
  const targetYear = parseInt(yearStr);
  const targetMonth = parseInt(monthStr);
  const targetDay = parseInt(date.split('-')[2]);
  const headerText = `${targetYear}.${targetMonth}`;

  // DatePeriodCalendar date-info 클릭 → 달력 팝업
  await pg.click('[class*="DatePeriodCalendar__date-info"]');
  await delay(1000);

  let found = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const coords = await pg.evaluate((headerText, targetDay) => {
      const dayStr = String(targetDay);
      let headerEl = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim();
        if (txt !== headerText) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0) { headerEl = el; break; }
      }
      if (!headerEl) return { found: false, reason: `header "${headerText}" not found` };
      const hRect = headerEl.getBoundingClientRect();
      const cx = (hRect.left + hRect.right) / 2;
      const halfW = (hRect.right - hRect.left) / 2 + 30;
      for (const cell of document.querySelectorAll('button, td, [role="gridcell"]')) {
        if (cell.offsetParent === null) continue;
        const cellTxt = (cell.textContent || '').trim();
        if (!cellTxt.startsWith(dayStr)) continue;
        if (cellTxt.length > dayStr.length && /\d/.test(cellTxt[dayStr.length])) continue;
        const r = cell.getBoundingClientRect();
        if (r.top < hRect.bottom - 10) continue;
        if (r.left < cx - halfW || r.right > cx + halfW) continue;
        if (cell.getAttribute('aria-disabled') === 'true') continue;
        const cls = (cell.className || '').toLowerCase();
        if (cls.includes('disabled') || cls.includes('prev') || cls.includes('next') || cls.includes('outside')) continue;
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { found: false, reason: 'day cell not in range' };
    }, headerText, targetDay);

    log(`  달력 탐색 attempt ${attempt + 1}: ${JSON.stringify(coords)}`);
    if (coords.found) {
      await pg.mouse.click(coords.x, coords.y);
      found = true;
      await delay(400);
      break;
    }

    const nextBtn = await pg.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el.offsetParent === null) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\d{4}\.\d{1,2}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width < 300 && r.height < 60 && r.width > 0;
      });
      if (headers.length === 0) return null;
      const lastH = headers[headers.length - 1];
      const lhRect = lastH.getBoundingClientRect();
      for (const btn of document.querySelectorAll('button')) {
        if (btn.offsetParent === null) continue;
        const br = btn.getBoundingClientRect();
        if (br.left >= lhRect.right + 5 && br.width > 0 && br.height > 0)
          return { x: br.left + br.width / 2, y: br.top + br.height / 2 };
      }
      return null;
    });
    if (!nextBtn) break;
    await pg.mouse.click(nextBtn.x, nextBtn.y);
    await delay(600);
  }

  if (!found) { log('❌ 날짜 선택 실패'); await pg.close(); browser.disconnect(); return; }

  // 적용 버튼 클릭
  const applied = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      if ((btn.textContent || '').trim() === '적용' && btn.offsetParent !== null) {
        btn.click(); return true;
      }
    }
    return false;
  });
  log(`  적용 버튼: ${applied}`);
  if (!applied) { log('❌ 적용 실패'); await pg.close(); browser.disconnect(); return; }
  await delay(2000);

  const dateInfo = await pg.evaluate(() => {
    const el = document.querySelector('[class*="DatePeriodCalendar__date-info"]');
    return el ? (el.textContent || '').trim() : 'NOT FOUND';
  });
  log(`  현재 날짜: ${dateInfo}`);
  await pg.screenshot({ path: '/tmp/intercept-01-date-selected.png' });

  // ── 3. B룸 18:00 슬롯 클릭 ──
  log('3. B룸 18:00 슬롯 클릭');
  const { room, start } = TARGET;
  const roomType = room.replace(/스터디룸?\s*/g, '').replace(/룸\s*$/, '').trim();
  const [hh, mm] = start.split(':').map(Number);
  const isAM = hh < 12;
  const displayHour = hh > 12 ? hh - 12 : (hh === 0 ? 12 : hh);
  const ampm = isAM ? '오전' : '오후';
  const hourMin = `${displayHour}:${String(mm).padStart(2, '0')}`;
  const timeDisplay = `${ampm} ${hourMin}`;
  log(`  roomType="${roomType}" time="${timeDisplay}"`);

  const slotResult = await pg.evaluate((roomType, timeDisplay, ampm, hourMin) => {
    // 1. 시간 요소 찾기
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
    const pattern = new RegExp(`${roomType}(?:룸|\\s|$)`, 'i');
    for (const el of allVisible) {
      const text = (el.textContent || '').trim();
      if (pattern.test(text) || text === roomType) {
        const rect = el.getBoundingClientRect();
        if (!roomXRange || rect.left < roomXRange.left)
          roomXRange = { left: rect.left, right: rect.right, cx: rect.left + rect.width / 2 };
      }
    }

    // 3. calendar-btn 클릭
    const calBtns = Array.from(document.querySelectorAll(
      '.calendar-btn, [class*="calendar-btn"], [class*="week-cell"] button, [class*="WeekCell"] button'
    )).filter(b => b.offsetParent !== null);

    const btnInfos = calBtns.map(b => {
      const r = b.getBoundingClientRect();
      return { el: b, cx: r.left + r.width / 2, cy: r.top + r.height / 2, cls: b.className || '', text: (b.textContent || '').trim() };
    });

    let candidates = btnInfos.filter(b => Math.abs(b.cy - targetY) <= 25);
    if (candidates.length === 0) candidates = btnInfos.filter(b => Math.abs(b.cy - targetY) <= 60);
    if (candidates.length === 0) candidates = btnInfos;

    if (roomXRange) {
      const inRoom = candidates.filter(b => b.cx >= roomXRange.left - 15 && b.cx <= roomXRange.right + 15);
      if (inRoom.length > 0) candidates = inRoom;
    }

    const notSoldout = candidates.filter(b => !b.cls.includes('soldout') && !b.cls.includes('disabled'));
    const final = notSoldout.length > 0 ? notSoldout : candidates;
    if (final.length === 0) return { found: false, reason: 'no button', targetY: Math.round(targetY), roomXRange };

    const best = final.sort((a, b) => Math.abs(a.cy - targetY) - Math.abs(b.cy - targetY))[0];
    best.el.scrollIntoView({ block: 'nearest' });
    best.el.click();
    return {
      found: true, clicked: true,
      btnText: best.text, btnClass: best.cls.slice(0, 80),
      pos: { cx: Math.round(best.cx), cy: Math.round(best.cy) },
      targetY: Math.round(targetY),
      roomXRange: roomXRange ? { l: Math.round(roomXRange.left), r: Math.round(roomXRange.right) } : null,
    };
  }, roomType, timeDisplay, ampm, hourMin);

  log(`  슬롯 클릭: ${JSON.stringify(slotResult)}`);
  if (!slotResult.found) {
    await pg.screenshot({ path: '/tmp/intercept-02-slot-fail.png' });
    log('❌ 슬롯 클릭 실패');
    await pg.close();
    browser.disconnect();
    return;
  }
  await delay(1500);
  await pg.screenshot({ path: '/tmp/intercept-02-popup.png' });
  log('  팝업 스크린샷: /tmp/intercept-02-popup.png');

  // ── 팝업 내용 확인 (적용날짜, 시간 표시) ──
  const panelInfo = await pg.evaluate(() => {
    const info = {};
    // 적용날짜 텍스트 수집
    const texts = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100) continue;
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 0 && txt.length < 40) texts.push(txt);
    }
    info.panelTexts = texts.slice(0, 30);
    // 설정변경 버튼 유무
    info.hasSaveBtn = Array.from(document.querySelectorAll('button')).some(b => (b.textContent || '').trim() === '설정변경' && b.offsetParent !== null);
    return info;
  });
  log(`  패널 텍스트: ${JSON.stringify(panelInfo.panelTexts)}`);
  log(`  설정변경 버튼: ${panelInfo.hasSaveBtn}`);

  // ── 4. 팝업 설정 (시작/종료시간 + 예약불가 + 설정변경) ──
  log('4. 팝업 설정');
  const endRounded = roundUpToHalfHour(TARGET.end);
  log(`  end: ${TARGET.end} → rounded: ${endRounded}`);

  // 시작시간 드롭다운
  async function selectTimeDropdown(which, timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const isAM = h < 12;
    const dispH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    const ap = isAM ? '오전' : '오후';
    const timeDisplay = `${ap} ${dispH}:${String(m).padStart(2, '0')}`;
    log(`    드롭다운(${which}): "${timeStr}" → "${timeDisplay}"`);

    // 트리거
    const trigRes = await pg.evaluate((which) => {
      const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
      const candidates = [];
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.left < 1100 || r.width < 10 || r.height < 5) continue;
        const txt = (el.textContent || '').trim();
        if (!timeRe.test(txt) || txt.length > 20) continue;
        candidates.push({ el, x: r.left, y: r.top });
      }
      if (candidates.length === 0) return { triggered: false, reason: 'no time in panel' };
      const btnCandidates = candidates.filter(c => c.el.tagName === 'BUTTON');
      const sorted = (btnCandidates.length >= 2 ? btnCandidates : candidates).sort((a, b) => a.x - b.x);
      const target = which === 'start' ? sorted[0] : sorted[sorted.length - 1];
      target.el.click();
      return { triggered: true, txt: (target.el.textContent || '').trim(), x: Math.round(target.x) };
    }, which);
    log(`    트리거: ${JSON.stringify(trigRes)}`);
    if (!trigRes.triggered) return false;
    await delay(600);

    const optRes = await pg.evaluate((timeDisplay, ap, dispH, m) => {
      const minStr = String(m).padStart(2, '0');
      const exact = timeDisplay;
      const noSpace = `${ap}${dispH}:${minStr}`;
      for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
        const r = btn.getBoundingClientRect();
        if (r.width < 5 || r.height < 3) continue;
        const txt = (btn.textContent || '').trim();
        if (txt === exact || txt === noSpace) { btn.click(); return { selected: true, txt, method: 'btn-select' }; }
      }
      const pattern = new RegExp(`^${ap}\\s*${dispH}:${minStr}$`);
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 3) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length > 12) continue;
        if (pattern.test(txt)) { el.click(); return { selected: true, txt, method: 'broad' }; }
      }
      return { selected: false };
    }, timeDisplay, ap, dispH, m);
    log(`    옵션: ${JSON.stringify(optRes)}`);
    return optRes.selected;
  }

  await selectTimeDropdown('start', TARGET.start);
  await delay(500);
  await selectTimeDropdown('end', endRounded);
  await delay(500);

  // 예약불가 선택
  const timeRe_s = /오[전후]\s*\d{1,2}:\d{2}/;
  const statusTexts_s = ['예약가능', '예약 가능', '-'];

  const triggerResult = await pg.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const statusTexts = ['예약가능', '예약 가능', '-'];
    for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
      const r = btn.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (btn.textContent || '').trim();
      if (timeRe.test(txt)) continue;
      if (statusTexts.includes(txt) || txt === '') {
        btn.click();
        return { triggered: true, txt, x: Math.round(r.left), y: Math.round(r.top), method: 'btn-form-control' };
      }
    }
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (timeRe.test(txt)) continue;
      if (statusTexts.includes(txt) || (txt.includes('예약가능') && txt.length < 15)) {
        el.click();
        return { triggered: true, txt, x: Math.round(r.left), y: Math.round(r.top), method: 'fallback' };
      }
    }
    return { triggered: false };
  });
  log(`  예약상태 트리거: ${JSON.stringify(triggerResult)}`);
  if (!triggerResult.triggered) { log('❌ 예약상태 트리거 실패'); await pg.close(); browser.disconnect(); return; }
  await delay(600);

  const optResult = await pg.evaluate(() => {
    const UNAVAIL = ['예약불가', '예약 불가'];
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 3) continue;
      const txt = (btn.textContent || '').trim();
      if (UNAVAIL.includes(txt)) { btn.click(); return { selected: true, txt, method: 'btn-select', x: Math.round(r.left) }; }
    }
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 5 || r.height < 3) continue;
      const txt = (el.textContent || '').trim();
      if (UNAVAIL.includes(txt)) { el.click(); return { selected: true, txt, x: Math.round(r.left), y: Math.round(r.top) }; }
    }
    return { selected: false };
  });
  log(`  예약불가 옵션: ${JSON.stringify(optResult)}`);
  if (!optResult.selected) { log('❌ 예약불가 선택 실패'); await pg.close(); browser.disconnect(); return; }
  await delay(500);

  await pg.screenshot({ path: '/tmp/intercept-03-before-save.png' });
  log('  설정변경 직전 스크린샷: /tmp/intercept-03-before-save.png');

  // 저장 전 패널 상세 정보 수집
  const preInfo = await pg.evaluate(() => {
    const info = {};
    // 적용날짜 찾기
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100) continue;
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (/\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/.test(txt)) {
        if (!info.dates) info.dates = [];
        info.dates.push(txt);
      }
      if (/오[전후]\s*\d{1,2}:\d{2}/.test(txt)) {
        if (!info.times) info.times = [];
        info.times.push(txt);
      }
      if (txt.includes('예약불가') || txt.includes('예약 불가')) {
        info.statusSelected = txt;
      }
    }
    return info;
  });
  log(`  패널 날짜: ${JSON.stringify(preInfo.dates)}`);
  log(`  패널 시간: ${JSON.stringify(preInfo.times)}`);
  log(`  선택 상태: ${JSON.stringify(preInfo.statusSelected)}`);

  // ── 5. 설정변경 클릭 ──
  log('5. 설정변경 클릭 (API 인터셉트 대기)');
  const saved = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      const text = (btn.textContent || '').trim();
      if ((text === '설정변경' || text.includes('설정변경')) && btn.offsetParent !== null) {
        btn.click(); return { clicked: true, text };
      }
    }
    return { clicked: false };
  });
  log(`  설정변경: ${JSON.stringify(saved)}`);

  // API 캡처 대기
  await delay(3000);

  // ── 결과 ──
  log('\n=== API 인터셉트 결과 ===');
  if (patchCalls.length === 0) {
    log('⚠️ PATCH /schedules 캡처 없음');
  } else {
    patchCalls.forEach((c, i) => {
      log(`[${i + 1}] URL: ${c.url}`);
      log(`[${i + 1}] Body: ${c.body}`);
      log(`[${i + 1}] HTTP: ${c.status || '응답 없음'} ${c.statusText || ''}`);
    });
  }

  // 응답 본문 캡처 시도
  for (const call of patchCalls) {
    try {
      const resp = await client.send('Network.getResponseBody', { requestId: call.id });
      log(`응답 본문: ${resp.body}`);
    } catch (e) {
      log(`응답 본문 캡처 실패: ${e.message}`);
    }
  }

  await pg.screenshot({ path: '/tmp/intercept-04-after.png' });
  log('최종 스크린샷: /tmp/intercept-04-after.png');

  await pg.close();
  browser.disconnect();
})().catch(e => {
  console.error(`❌ 오류: ${e.message}`);
  process.exit(1);
});
