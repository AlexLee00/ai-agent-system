const { delay } = require('./utils');

async function loginToPickko(page, id, pw, delayFn) {
  const d = delayFn || delay;
  await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate((id, pw) => {
    document.getElementById('mn_id').value = id;
    document.getElementById('mn_pw').value = pw;
    document.getElementById('loginButton').click();
  }, id, pw);
  await d(3000);
}

// 시간 문자열 → HH:MM 정규화 (내부용)
function _normalizeTime(str) {
  if (!str) return '';
  const m1 = str.match(/(오전|오후)\s*(\d+)시\s*(\d+)?분?/);
  if (m1) {
    let h = parseInt(m1[2]); const m = parseInt(m1[3] || '0');
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

/**
 * 픽코 어드민 스터디룸 예약 일괄 조회
 *
 * pickko-kiosk-monitor.js의 fetchKioskReservations 일반화 버전.
 * 날짜+상태+이용금액+정렬 필터로 일괄 조회 → colMap 구조화 파싱.
 *
 * @param {object} page      - Puppeteer page (픽코 로그인 완료 상태)
 * @param {string} startDate - 이용일 시작 'YYYY-MM-DD' (sortBy=sd_start) 또는 기준 날짜
 * @param {object} [opts]
 *   endDate: string        — 이용일 종료 (sortBy=sd_start일 때만, 기본='')
 *   statusKeyword: string  — 상태 필터 텍스트 (기본='결제완료', ''=전체 상태)
 *   minAmount: number      — 이용금액 하한 (기본=0=필터 없음, 1=키오스크 예약만)
 *   sortBy: string         — 'sd_start'(이용일시, 기본) | 'sd_regdate'(접수일시)
 *   receiptDate: string    — 접수일 필터 'YYYY-MM-DD' (sortBy=sd_regdate 전용)
 * @returns {{ entries: Array<{phoneRaw,name,room,date,start,end,amount,receiptText}>, fetchOk: boolean }}
 */
async function fetchPickkoEntries(page, startDate, opts = {}) {
  const {
    endDate = '',
    statusKeyword = '결제완료',
    minAmount = 0,
    sortBy = 'sd_start',
    receiptDate = ''
  } = opts;

  await page.goto('https://pickkoadmin.com/study/index.html', {
    waitUntil: 'networkidle2', timeout: 30000
  });
  await delay(2000);

  // 필터 설정
  await page.evaluate((sd, ed, sk, ma, sb) => {
    // 이용일시 기준 날짜 필터 (sortBy=sd_start일 때만)
    if (sb !== 'sd_regdate') {
      const startEl = document.querySelector('input[name="sd_start_up"]');
      if (startEl) {
        startEl.value = sd;
        startEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (ed) {
        const endEl = document.querySelector('input[name="sd_start_dw"]');
        if (endEl) {
          endEl.removeAttribute('readonly');
          endEl.value = ed;
          endEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    // 접수일시 기준 정렬 (sortBy=sd_regdate일 때)
    if (sb === 'sd_regdate') {
      const radio = document.querySelector('input[name="o_key"][value="sd_regdate"]');
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // 이용금액 하한 필터
    if (ma > 0) {
      const amtEl = document.querySelector('input[name="order_price_up"]');
      if (amtEl) {
        amtEl.value = String(ma);
        amtEl.dispatchEvent(new Event('input', { bubbles: true }));
        amtEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    // 상태 필터
    if (sk) {
      const selects = Array.from(document.querySelectorAll('select'));
      for (const sel of selects) {
        for (const opt of Array.from(sel.options)) {
          const t = opt.text.trim();
          if (t.includes(sk) || opt.value.includes(sk)) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }
    }
  }, startDate, endDate, statusKeyword, minAmount, sortBy);

  // 검색 실행
  try {
    await Promise.all([
      page.click('input[type="submit"][value="검색"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);
  } catch (_e) {}
  await delay(2000);

  // colMap 분석
  const colMap = await page.evaluate(() => {
    const result = {
      name: -1, phone: -1, room: -1,
      startTime: -1, endTime: -1, amount: -1, status: -1, receiptTime: -1,
      isCombined: false, headers: []
    };
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
      if (t === '접수일시' || (t.includes('접수') && t.includes('일'))) result.receiptTime = i;
    });
    return result;
  });

  // 행 파싱
  const rawEntries = await page.evaluate((sd, cm, sk, ma, rd) => {
    const entries = [];
    const trs = Array.from(document.querySelectorAll('tbody tr'));
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (!tr.querySelector('a[href*="/study/view/"]')) continue;
      if (tds.length < 3) continue;

      const getText = (idx) => idx >= 0 && tds[idx]
        ? tds[idx].textContent.replace(/\s+/g, ' ').trim() : '';

      // 접수일시 필터 (receiptDate가 있을 때만)
      if (rd && cm.receiptTime >= 0) {
        const rText = getText(cm.receiptTime);
        let rDate = (rText.match(/(\d{4})-(\d{2})-(\d{2})/) || [])[0] || '';
        if (!rDate) {
          const m = rText.match(/(\d{2,4})[.\s]+(\d{1,2})[.\s]+(\d{1,2})/);
          if (m) {
            const y = m[1].length === 2 ? '20' + m[1] : m[1];
            rDate = `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
          }
        }
        // 접수일시 내림차순 → 대상일보다 이전이면 이후 행도 이전 → 중단
        if (rDate && rDate < rd) break;
        if (rDate !== rd) continue; // 미래 날짜 스킵 (파싱 실패 포함)
      }

      // 상태 필터
      if (sk) {
        const statusText = cm.status >= 0 ? getText(cm.status) : tr.textContent;
        if (!statusText.includes(sk)) continue;
      }

      // 이용금액 필터
      if (ma > 0) {
        const amtText = cm.amount >= 0 ? getText(cm.amount) : '';
        const amtNum = parseInt((amtText || '0').replace(/[^0-9]/g, ''), 10);
        if (cm.amount >= 0 && amtNum < ma) continue;
      }

      const name = getText(cm.name);
      const phoneRaw = getText(cm.phone).replace(/[^0-9]/g, '');
      const room = getText(cm.room);
      const combinedText = cm.startTime >= 0 ? getText(cm.startTime) : '';
      const endText = cm.isCombined ? '' : (cm.endTime >= 0 ? getText(cm.endTime) : '');
      const receiptText = cm.receiptTime >= 0 ? getText(cm.receiptTime) : '';

      let reservationDate = '', startText = combinedText;
      const dm = combinedText.match(/(\d{4})-(\d{2})-(\d{2})/)
        || combinedText.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
      if (dm) {
        reservationDate = combinedText.includes('년')
          ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`
          : dm[0];
        startText = combinedText.slice(combinedText.indexOf(dm[0]) + dm[0].length).trim();
      }
      const ti = startText.indexOf('~');
      const parsedStart = ti >= 0 ? startText.slice(0, ti).trim() : startText;
      const parsedEnd = cm.isCombined ? (ti >= 0 ? startText.slice(ti + 1).trim() : '') : endText;
      const amtText2 = cm.amount >= 0 ? getText(cm.amount) : '';
      entries.push({ name, phoneRaw, room, reservationDate, startText: parsedStart, endText: parsedEnd, amtText: amtText2, receiptText });
    }
    return entries;
  }, startDate, colMap, statusKeyword, minAmount, receiptDate);

  const entries = rawEntries.map(e => ({
    name: e.name,
    phoneRaw: e.phoneRaw,
    room: e.room,
    date: e.reservationDate || startDate,
    start: _normalizeTime(e.startText),
    end: _normalizeTime(e.endText),
    amount: parseInt((e.amtText || '0').replace(/[^0-9]/g, ''), 10),
    receiptText: e.receiptText || ''
  })).filter(e => e.phoneRaw && e.date && e.start);

  return { entries, fetchOk: colMap.headers.length > 0 };
}

module.exports = { loginToPickko, fetchPickkoEntries };
