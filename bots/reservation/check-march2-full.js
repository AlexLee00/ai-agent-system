/**
 * 2026-03-02 B룸 전체 슬롯 상태 확인
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

  await pg.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await pg.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  // 2026-03-02로 이동 (check-march2-naver.js와 동일 로직)
  await pg.click('[class*="DatePeriodCalendar__date-info"]');
  await new Promise(r => setTimeout(r, 1000));

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
      return { found: false, reason: '2일 cell not found' };
    }, '2026.3', 2);

    if (coords.found) { await pg.mouse.click(coords.x, coords.y); found = true; await new Promise(r => setTimeout(r, 400)); break; }

    const nextBtn = await pg.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('*')).filter(el => {
        if (!el.offsetParent) return false;
        const txt = (el.textContent || '').trim();
        if (!/^\d{4}\.\d{1,2}$/.test(txt)) return false;
        const r = el.getBoundingClientRect();
        return r.width < 300 && r.height < 60 && r.width > 0;
      });
      if (!headers.length) return null;
      const lhRect = headers[headers.length - 1].getBoundingClientRect();
      for (const btn of document.querySelectorAll('button')) {
        if (!btn.offsetParent) continue;
        const br = btn.getBoundingClientRect();
        if (br.left >= lhRect.right + 5 && br.width > 0) return { x: br.left + br.width / 2, y: br.top + br.height / 2 };
      }
      return null;
    });
    if (!nextBtn) break;
    await pg.mouse.click(nextBtn.x, nextBtn.y);
    await new Promise(r => setTimeout(r, 600));
  }
  if (!found) { console.log('날짜 선택 실패'); await pg.close(); browser.disconnect(); return; }

  await pg.evaluate(() => {
    for (const btn of document.querySelectorAll('button'))
      if ((btn.textContent || '').trim() === '적용' && btn.offsetParent !== null) { btn.click(); return; }
  });
  await new Promise(r => setTimeout(r, 2500));

  console.log('날짜:', await pg.evaluate(() => {
    const el = document.querySelector('[class*="DatePeriodCalendar__date-info"]');
    return el ? el.textContent.trim() : '?';
  }));

  // 오후 7:00 영역으로 스크롤 (18:00~20:00 전체 보기)
  await pg.evaluate(() => {
    // "7:00" 레이블 찾기
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (txt === '7:00') { el.scrollIntoView({ block: 'center' }); return; }
    }
    // fallback: "6:00"
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      if ((el.textContent || '').trim() === '6:00') { el.scrollIntoView({ block: 'center' }); return; }
    }
  });
  await new Promise(r => setTimeout(r, 1000));

  await pg.screenshot({ path: '/tmp/march2-full-check.png' });
  console.log('스크린샷: /tmp/march2-full-check.png');

  // 화면에 보이는 모든 슬롯 상태 + 시간 레이블
  const state = await pg.evaluate(() => {
    const results = { buttons: [], blocks: [], timeLabels: [] };

    // 시간 레이블
    for (const el of document.querySelectorAll('[class*="Calendar__time"], [class*="calendar__time"]')) {
      const r = el.getBoundingClientRect();
      const txt = (el.textContent || '').trim();
      if (r.top > 100 && r.top < 900 && txt) results.timeLabels.push({ txt, y: Math.round(r.top) });
    }

    // calendar-btn
    for (const el of document.querySelectorAll('[class*="calendar-btn"], .calendar-btn')) {
      const r = el.getBoundingClientRect();
      if (r.top < 100 || r.top > 900 || r.width < 10) continue;
      results.buttons.push({
        txt: (el.textContent || '').trim().slice(0, 30),
        cls: (el.className || '').trim(),
        y: Math.round(r.top), x: Math.round(r.left)
      });
    }

    // 예약불가 표시 (다른 형태)
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length > 0) continue;
      const txt = (el.textContent || '').trim();
      if (!txt.includes('예약불가')) continue;
      if (txt.length > 20) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 100 || r.top > 900 || r.width < 10) continue;
      const cls = (el.className || '').trim();
      results.blocks.push({ txt, cls, y: Math.round(r.top), x: Math.round(r.left), tag: el.tagName });
    }

    return results;
  });

  console.log('\n시간 레이블:');
  state.timeLabels.sort((a, b) => a.y - b.y).forEach(l => console.log(`  Y=${l.y}: "${l.txt}"`));

  console.log('\n예약가능 버튼:');
  state.buttons.sort((a, b) => a.y - b.y || a.x - b.x).forEach(b => console.log(`  [${b.x},${b.y}] "${b.txt}" (${b.cls.slice(0, 60)})`));

  console.log('\n예약불가 표시:');
  if (state.blocks.length === 0) console.log('  (없음)');
  state.blocks.sort((a, b) => a.y - b.y || a.x - b.x).forEach(b => console.log(`  [${b.x},${b.y}] <${b.tag}> "${b.txt}" cls="${b.cls.slice(0, 60)}"`));

  await pg.close();
  browser.disconnect();
})().catch(e => console.error(e.message));
