/**
 * test-api-response.js
 * API PATCH /schedules 응답 코드 확인 (stock:null vs stock:1 비교)
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { delay, log } = require('./lib/utils');

const BIZE_ID = '596871';
const BOOKING_URL = `https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-calendar-view`;

(async () => {
  const wsFile = path.join(process.env.HOME, '.openclaw/workspace/naver-monitor-ws.txt');
  const ws = fs.readFileSync(wsFile, 'utf8').trim();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });

  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080 });

  // CDP Network 인터셉트 — 요청 + 응답 모두 캡처
  const client = await pg.createCDPSession();
  await client.send('Network.enable');

  const apiCalls = {};  // requestId → { url, body, status, response }

  client.on('Network.requestWillBeSent', (params) => {
    if (params.request.url.includes('/schedules') && params.request.method === 'PATCH') {
      apiCalls[params.requestId] = {
        url: params.request.url,
        body: params.request.postData,
        headers: params.request.headers,
      };
      console.log(`\n🔍 PATCH 요청:`);
      console.log(`  Body: ${params.request.postData}`);
    }
  });

  client.on('Network.responseReceived', (params) => {
    if (apiCalls[params.requestId]) {
      apiCalls[params.requestId].status = params.response.status;
      apiCalls[params.requestId].statusText = params.response.statusText;
      console.log(`📨 응답: HTTP ${params.response.status} ${params.response.statusText}`);
    }
  });

  client.on('Network.loadingFailed', (params) => {
    if (apiCalls[params.requestId]) {
      apiCalls[params.requestId].failed = params.errorText;
      console.log(`❌ 요청 실패: ${params.errorText}`);
    }
  });

  // 2026-03-02로 이동
  log('booking calendar 접속');
  await pg.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  await delay(2000);

  await pg.click('[class*="DatePeriodCalendar__date-info"]');
  await delay(1000);

  let found = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const coords = await pg.evaluate((headerText, targetDay) => {
      const dayStr = String(targetDay);
      let headerEl = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.offsetParent === null) continue;
        if ((el.textContent || '').trim() !== headerText) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0) { headerEl = el; break; }
      }
      if (!headerEl) return { found: false };
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
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return { found: false };
    }, '2026.3', 2);
    if (coords.found) { await pg.mouse.click(coords.x, coords.y); found = true; await delay(400); break; }
    const nextBtn = await pg.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('*')).filter(el => {
        if (el.offsetParent === null) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\d{4}\.\d{1,2}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width < 300 && r.height < 60 && r.width > 0;
      });
      if (!headers.length) return null;
      const lhRect = headers[headers.length - 1].getBoundingClientRect();
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

  if (!found) { log('날짜 선택 실패'); await pg.close(); browser.disconnect(); return; }
  const applied = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button'))
      if ((btn.textContent || '').trim() === '적용' && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  });
  await delay(2000);
  log(`날짜 이동: ${await pg.evaluate(() => { const el = document.querySelector('[class*="DatePeriodCalendar__date-info"]'); return el ? el.textContent.trim() : '?'; })}`);

  // ── 방법 1: UI 클릭으로 설정변경 + stock 수량 확인 ──
  // B룸 18:00 클릭
  await pg.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() === '6:00') { el.scrollIntoView({ block: 'center' }); return; }
    }
  });
  await delay(500);

  const slotClicked = await pg.evaluate(() => {
    // 6:00 시간 Y 구하기
    let targetY = null;
    for (const el of document.querySelectorAll('[class*="Calendar__time"]')) {
      if ((el.textContent || '').trim() === '6:00') { targetY = el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2; break; }
    }
    if (!targetY) return { found: false, reason: 'no 6:00 el' };

    // B룸 X 범위
    let roomXRange = null;
    for (const el of Array.from(document.querySelectorAll('*')).filter(e => !e.offsetParent ? false : e.children.length === 0 && e.getBoundingClientRect().top < 450)) {
      const txt = (el.textContent || '').trim();
      if (/B(?:룸|\s|$)/i.test(txt)) {
        const r = el.getBoundingClientRect();
        if (!roomXRange || r.left < roomXRange.left) roomXRange = { left: r.left, right: r.right };
      }
    }

    // calendar-btn near targetY + B룸 X
    const calBtns = Array.from(document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]')).filter(b => b.offsetParent !== null);
    let candidates = calBtns.map(b => { const r = b.getBoundingClientRect(); return { el: b, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })
      .filter(b => Math.abs(b.cy - targetY) <= 60);
    if (roomXRange) { const inRoom = candidates.filter(b => b.cx >= roomXRange.left - 15 && b.cx <= roomXRange.right + 15); if (inRoom.length) candidates = inRoom; }
    if (!candidates.length) return { found: false, reason: 'no btn', targetY, roomXRange };
    const best = candidates.sort((a, b) => Math.abs(a.cy - targetY) - Math.abs(b.cy - targetY))[0];
    best.el.click();
    return { found: true, cx: Math.round(best.cx), cy: Math.round(best.cy) };
  });
  log(`B룸 18:00 슬롯: ${JSON.stringify(slotClicked)}`);
  await delay(1500);

  // 패널의 수량(stock) 값 확인
  const panelStock = await pg.evaluate(() => {
    // "수량" 라벨 찾기 → 인근 input 또는 텍스트 수집
    const info = { stockInputs: [], allPanelTexts: [] };
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100) continue;
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 0 && txt.length < 50) info.allPanelTexts.push({ tag: el.tagName, txt, cls: (el.className || '').slice(0, 40) });
    }
    // input 요소들
    for (const inp of document.querySelectorAll('input')) {
      const r = inp.getBoundingClientRect();
      if (r.left < 1100) continue;
      info.stockInputs.push({ type: inp.type, name: inp.name, id: inp.id, value: inp.value, cls: (inp.className || '').slice(0, 40) });
    }
    return info;
  });
  log('패널 input 요소:');
  panelStock.stockInputs.forEach(i => log(`  input: type=${i.type} name=${i.name} id=${i.id} value=${i.value} cls=${i.cls}`));
  log('패널 텍스트 (수량 관련):');
  panelStock.allPanelTexts.filter(t => /수량|stock|\d+/.test(t.txt)).slice(0, 15).forEach(t => log(`  [${t.tag}] "${t.txt}" ${t.cls}`));

  await pg.screenshot({ path: '/tmp/api-resp-panel.png' });
  log('패널 스크린샷: /tmp/api-resp-panel.png');

  // 시작/종료 시간 + 예약불가 설정
  const startSet = await pg.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (!timeRe.test(txt) || txt.length > 20) continue;
      candidates.push({ el, x: r.left });
    }
    const btnC = candidates.filter(c => c.el.tagName === 'BUTTON');
    const sorted = (btnC.length >= 2 ? btnC : candidates).sort((a, b) => a.x - b.x);
    if (!sorted.length) return false;
    sorted[0].el.click();
    return (sorted[0].el.textContent || '').trim();
  });
  log(`시작시간 트리거: "${startSet}"`);
  await delay(600);
  const startOpt = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const txt = (btn.textContent || '').trim();
      if (txt === '오후 6:00') { btn.click(); return txt; }
    }
    return null;
  });
  log(`시작시간 옵션: "${startOpt}"`);
  await delay(500);

  const endSet = await pg.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100 || r.width < 10 || r.height < 5) continue;
      const txt = (el.textContent || '').trim();
      if (!timeRe.test(txt) || txt.length > 20) continue;
      candidates.push({ el, x: r.left });
    }
    const btnC = candidates.filter(c => c.el.tagName === 'BUTTON');
    const sorted = (btnC.length >= 2 ? btnC : candidates).sort((a, b) => a.x - b.x);
    if (!sorted.length) return false;
    sorted[sorted.length - 1].el.click();
    return (sorted[sorted.length - 1].el.textContent || '').trim();
  });
  log(`종료시간 트리거: "${endSet}"`);
  await delay(600);
  const endOpt = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const txt = (btn.textContent || '').trim();
      if (txt === '오후 8:00') { btn.click(); return txt; }
    }
    return null;
  });
  log(`종료시간 옵션: "${endOpt}"`);
  await delay(500);

  // 예약불가 선택
  const statusTrig = await pg.evaluate(() => {
    const timeRe = /오[전후]\s*\d{1,2}:\d{2}/;
    for (const btn of document.querySelectorAll('button.form-control, button[class*="form-control"]')) {
      const r = btn.getBoundingClientRect();
      if (r.left < 1100 || r.top < 200) continue;
      const txt = (btn.textContent || '').trim();
      if (!timeRe.test(txt)) { btn.click(); return txt; }
    }
    return null;
  });
  log(`예약상태 트리거: "${statusTrig}"`);
  await delay(600);
  const statusOpt = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button.btn-select, button[class*="btn-select"]')) {
      const txt = (btn.textContent || '').trim();
      if (txt === '예약불가') { btn.click(); return txt; }
    }
    return null;
  });
  log(`예약불가 선택: "${statusOpt}"`);
  await delay(500);

  // 설정변경 전 패널 전체 텍스트 + stock input 재확인
  const beforeSave = await pg.evaluate(() => {
    const texts = [];
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.left < 1100) continue;
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 0 && txt.length < 50) texts.push(txt);
    }
    // 수량 input
    const inputs = [];
    for (const inp of document.querySelectorAll('input')) {
      const r = inp.getBoundingClientRect();
      if (r.left < 1100) continue;
      inputs.push({ name: inp.name, id: inp.id, value: inp.value, type: inp.type });
    }
    return { texts: texts.slice(0, 40), inputs };
  });
  log(`설정변경 전 패널: ${JSON.stringify(beforeSave.texts)}`);
  log(`설정변경 전 inputs: ${JSON.stringify(beforeSave.inputs)}`);

  await pg.screenshot({ path: '/tmp/api-resp-before-save.png' });

  // 설정변경 클릭
  const saved = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button'))
      if ((btn.textContent || '').trim() === '설정변경' && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  });
  log(`설정변경: ${saved}`);

  await delay(3000);

  log('\n=== 최종 API 결과 ===');
  Object.values(apiCalls).forEach(c => {
    log(`URL: ${c.url}`);
    log(`Body: ${c.body}`);
    log(`Status: ${c.status} ${c.statusText || ''}`);
    if (c.failed) log(`Failed: ${c.failed}`);
  });

  await pg.screenshot({ path: '/tmp/api-resp-after.png' });
  log('최종 스크린샷: /tmp/api-resp-after.png');

  await pg.close();
  browser.disconnect();
})().catch(e => console.error(`❌ 오류: ${e.message}`));
