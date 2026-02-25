/**
 * 2026-03-02 네이버 캘린더 B룸 18:00 상태 확인
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BIZE_ID = '596871';
const BOOKING_URL = `https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-calendar-view`;

(async () => {
  const wsFile = path.join(process.env.HOME, '.openclaw/workspace/naver-monitor-ws.txt');
  const ws = fs.readFileSync(wsFile, 'utf8').trim();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });

  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080 });

  // booking calendar 접속
  await pg.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // 현재 date-info 텍스트 확인
  const dateInfo = await pg.evaluate(() => {
    const el = document.querySelector('[class*="DatePeriodCalendar__date-info"]');
    return el ? (el.textContent || '').trim() : 'NOT FOUND';
  });
  console.log(`현재 날짜 표시: ${dateInfo}`);

  // DatePeriodCalendar date-info 클릭 → 달력 팝업 열기
  await pg.click('[class*="DatePeriodCalendar__date-info"]');
  await new Promise(r => setTimeout(r, 1000));

  // 달력에서 2026.3 헤더 찾기 → 2일 클릭
  let found = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const coords = await pg.evaluate(() => {
      const headerText = '2026.3';
      const targetDay = 2;
      const dayStr = String(targetDay);

      let headerEl = null;
      for (const el of document.querySelectorAll('*')) {
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim();
        if (txt !== headerText) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0) { headerEl = el; break; }
      }
      if (!headerEl) return { found: false, reason: 'header not found' };

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
      return { found: false, reason: '2일 cell not in header range' };
    });

    console.log(`달력 탐색 attempt ${attempt + 1}: ${JSON.stringify(coords)}`);
    if (coords.found) {
      await pg.mouse.click(coords.x, coords.y);
      found = true;
      await new Promise(r => setTimeout(r, 400));
      break;
    }

    // > 버튼 클릭 (다음 달)
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
        if (br.left >= lhRect.right + 5 && br.width > 0 && br.height > 0) {
          return { x: br.left + br.width / 2, y: br.top + br.height / 2 };
        }
      }
      return null;
    });
    if (!nextBtn) break;
    await pg.mouse.click(nextBtn.x, nextBtn.y);
    await new Promise(r => setTimeout(r, 600));
  }

  if (!found) {
    console.log('❌ 2026-03-02 날짜 선택 실패');
    await pg.screenshot({ path: '/tmp/march2-check-fail.png' });
    await pg.close();
    browser.disconnect();
    return;
  }

  // 적용 버튼 클릭
  const applied = await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button')) {
      if ((btn.textContent || '').trim() === '적용' && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  console.log(`적용 버튼: ${applied}`);
  await new Promise(r => setTimeout(r, 2500));

  // 현재 date-info 다시 확인
  const dateInfo2 = await pg.evaluate(() => {
    const el = document.querySelector('[class*="DatePeriodCalendar__date-info"]');
    return el ? (el.textContent || '').trim() : 'NOT FOUND';
  });
  console.log(`날짜 이동 후: ${dateInfo2}`);

  // B룸 18:00 영역으로 스크롤 후 스크린샷
  await pg.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt === '6:00') { el.scrollIntoView({ block: 'center' }); return; }
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  await pg.screenshot({ path: '/tmp/march2-b-18h.png', fullPage: false });
  console.log('스크린샷: /tmp/march2-b-18h.png');

  // B룸 18시 상태 텍스트 추출
  const slotInfo = await pg.evaluate(() => {
    const results = [];
    // calendar-btn 버튼들의 상태 확인
    for (const btn of document.querySelectorAll('.calendar-btn, [class*="calendar-btn"]')) {
      const r = btn.getBoundingClientRect();
      if (r.top < 200 || r.top > 800) continue; // 화면 내 요소만
      const txt = (btn.textContent || '').trim();
      const cls = btn.className || '';
      results.push({ txt: txt.slice(0, 50), cls: cls.slice(0, 60), y: Math.round(r.top), x: Math.round(r.left) });
    }
    return results;
  });
  console.log('calendar-btn 상태:');
  slotInfo.forEach(s => console.log(`  [${s.x},${s.y}] cls="${s.cls.slice(0,40)}" txt="${s.txt}"`));

  await pg.close();
  browser.disconnect();
})().catch(e => console.error(e.message));
