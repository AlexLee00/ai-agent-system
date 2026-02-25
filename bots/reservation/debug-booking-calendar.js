/**
 * debug-booking-calendar.js — booking calendar UI 구조 디버그
 * 실행 중인 naver-browser-stub에 CDP 연결해서 DOM 분석
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const NAVER_WS_FILE = path.join(WORKSPACE, 'naver-monitor-ws.txt');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';

(async () => {
  const ws = fs.readFileSync(NAVER_WS_FILE, 'utf8').trim();
  console.log('CDP 연결:', ws.slice(0, 60));

  const browser = await puppeteer.connect({ browserWSEndpoint: ws });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  console.log('URL:', page.url().slice(0, 100));

  // 1. 전체 페이지 스크린샷
  await page.screenshot({ path: '/tmp/booking-full.png', fullPage: true });
  console.log('스크린샷 저장: /tmp/booking-full.png');

  // 2. DOM 구조 분석
  const domInfo = await page.evaluate(() => {
    // a) 최상위 class 목록
    const allClasses = new Set();
    document.querySelectorAll('[class]').forEach(el => {
      (el.className || '').split(' ').forEach(c => { if (c) allClasses.add(c); });
    });
    const bookingClasses = [...allClasses].filter(c =>
      /slot|Slot|time|Time|cell|Cell|grid|Grid|avail|Avail|book|Book|room|Room|row|Row|period|Period/i.test(c)
    ).slice(0, 40);

    // b) 예약가능 관련 요소
    const availBtns = Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .filter(el => (el.textContent || '').includes('예약가능') && el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').slice(0, 30),
        className: (el.className || '').slice(0, 60),
        parentClass: (el.parentElement?.className || '').slice(0, 60),
        rect: el.getBoundingClientRect ? (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null
      }));

    // c) 시간 그리드 관련 요소 (19:00 찾기)
    const timeEls = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        const t = (el.textContent || '').trim();
        return (t === '19:00' || t === '오후 7:00' || t === '19') && el.children.length === 0;
      })
      .map(el => ({
        tag: el.tagName,
        text: el.textContent.trim(),
        className: (el.className || '').slice(0, 60),
        parentClass: (el.parentElement?.className || '').slice(0, 60),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()
      }));

    // d) 현재 뷰 구조 (상위 5 레벨 클래스)
    const mainContent = document.querySelector('main, [role="main"], #content, .content');
    const topClasses = mainContent
      ? Array.from(mainContent.querySelectorAll('[class]')).slice(0, 10).map(el => (el.className || '').slice(0, 50))
      : [];

    return { bookingClasses, availBtns, timeEls, topClasses };
  });

  console.log('\n=== 예약가능 버튼 목록 ===');
  domInfo.availBtns.forEach((b, i) => console.log(`  [${i}] ${JSON.stringify(b)}`));

  console.log('\n=== 19:00 관련 요소 ===');
  domInfo.timeEls.forEach((t, i) => console.log(`  [${i}] ${JSON.stringify(t)}`));

  console.log('\n=== booking 관련 class 목록 ===');
  console.log(domInfo.bookingClasses.join(', '));

  // 3. 19:00 근처로 스크롤 후 스크린샷
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('*'));
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if ((t === '19:00' || t === '오후 7:00') && el.children.length === 0) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        return;
      }
    }
    // 못찾으면 아래쪽으로 스크롤
    window.scrollTo(0, 2000);
  });
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: '/tmp/booking-19h.png' });
  console.log('\n19:00 근처 스크린샷: /tmp/booking-19h.png');

  await page.close();
  browser.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
