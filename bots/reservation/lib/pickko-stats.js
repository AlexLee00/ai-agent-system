'use strict';

/**
 * lib/pickko-stats.js — 픽코 매출통계 스크래퍼
 *
 * 픽코 설정 > 매출통계 > 매출현황 페이지 파싱
 * URL 패턴:
 *   월별 합계: https://pickkoadmin.com/manager/statistic/month/{year}/{month}.html
 *   일별 상세: https://pickkoadmin.com/manager/statistic/day/{YYYY-MM-DD}.html
 */

const { delay } = require('./utils');

function normalizeStudyRoomLabel(description) {
  const text = String(description || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const roomMatch = text.match(/스터디룸\s*[\(\[]?\s*([A-Z])\s*-?\s*(\d*)\s*[\)\]]?/i);
  if (!roomMatch) return null;

  const alpha = String(roomMatch[1] || '').toUpperCase();
  const digits = String(roomMatch[2] || '');
  return `스터디룸${alpha}${digits}`;
}

// ─── 월별 매출 조회 ────────────────────────────────────────────────

/**
 * 월별 일자별 매출 조회
 *
 * @param {object} page  - Puppeteer page (픽코 로그인 완료)
 * @param {number} year  - 연도 (e.g. 2026)
 * @param {number} month - 월 (1~12)
 * @returns {Array<{ date, netRevenue, refundAmount, grossRevenue }>}
 *   netRevenue   = 매출(결제금액 - 환불금액) 합계
 *   grossRevenue = 결제금액 합계
 *   refundAmount = 환불금액 합계
 */
async function fetchMonthlyRevenue(page, year, month) {
  const url = `https://pickkoadmin.com/manager/statistic/month/${year}/${month}.html`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  const rows = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const getText = (i) => (tds[i] ? tds[i].textContent.trim() : '');
      const parseWon = (s) => parseInt(s.replace(/[^0-9]/g, '') || '0', 10);

      const date = getText(0);  // YYYY-MM-DD
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

      return {
        date,
        grossRevenue: parseWon(getText(6)),   // 결제금액 합계
        refundAmount: parseWon(getText(13)),   // 환불금액 합계 (추정 인덱스)
        netRevenue:   parseWon(getText(15)),   // 매출(결제-환불) 합계
      };
    }).filter(Boolean);
  });

  return rows;
}

// ─── 특정 날짜 매출 조회 ────────────────────────────────────────────

/**
 * 특정 날짜 매출 조회 (월별에서 해당 날짜 1행만 추출)
 *
 * @param {object} page
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {{ date, netRevenue, grossRevenue, refundAmount } | null}
 */
async function fetchDailyRevenue(page, date) {
  const [year, month] = date.split('-').map(Number);
  const rows = await fetchMonthlyRevenue(page, year, month);
  return rows.find(r => r.date === date) || null;
}

// ─── 일별 거래 상세 조회 (스터디룸 구분) ─────────────────────────

/**
 * 일별 거래 상세 조회
 * 스터디룸 예약 / 일반 이용 분리
 *
 * 주문정보 패턴:
 *   '스터디룸A1 02월 01일 18시 00분 ~ 19시 50분 (이름)' → studyRoom = 'A1'
 *   '스터디룸B 02월 26일...'                             → studyRoom = 'B'
 *   '3시간(2026-02-01~...) 서비스 신청 (이름)'           → studyRoom = null (일반)
 *
 * @param {object} page
 * @param {string} date - 'YYYY-MM-DD'
 * @returns {{
 *   transactions: Array<{ no, description, netRevenue, studyRoom }>,
 *   studyRoomRevenue: object,   // { '스터디룸A1': 0, '스터디룸A2': 0, '스터디룸B': 0 }
 *   generalRevenue: number,
 *   totalRevenue: number,
 * }}
 */
async function fetchDailyDetail(page, date) {
  const url = `https://pickkoadmin.com/manager/statistic/day/${date}.html`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  const transactions = await page.evaluate(() => {
    const normalizeStudyRoomLabel = (description) => {
      const text = String(description || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) return null;

      const roomMatch = text.match(/스터디룸\s*[\(\[]?\s*([A-Z])\s*-?\s*(\d*)\s*[\)\]]?/i);
      if (!roomMatch) return null;

      const alpha = String(roomMatch[1] || '').toUpperCase();
      const digits = String(roomMatch[2] || '');
      return `스터디룸${alpha}${digits}`;
    };

    return Array.from(document.querySelectorAll('table tbody tr')).map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const getText = (i) => (tds[i] ? tds[i].textContent.trim() : '');
      const parseWon = (s) => parseInt(s.replace(/[^0-9]/g, '') || '0', 10);

      const no          = getText(0);
      const description = getText(1);
      // 상세 페이지는 주문정보(1), 주문금액(2..6), 환불(7..12), 매출합계(16)
      const netRevenue  = parseWon(getText(16));

      if (!no || !/^\d+$/.test(no)) return null;

      // 스터디룸 판별
      const studyRoom = normalizeStudyRoomLabel(description);

      return { no: Number(no), description, netRevenue, studyRoom };
    }).filter(Boolean);
  });

  // 룸별·일반 합산
  const studyRoomRevenue = {};
  let generalRevenue = 0;

  for (const t of transactions) {
    if (t.studyRoom) {
      studyRoomRevenue[t.studyRoom] = (studyRoomRevenue[t.studyRoom] || 0) + t.netRevenue;
    } else {
      generalRevenue += t.netRevenue;
    }
  }

  const totalRevenue = Object.values(studyRoomRevenue).reduce((s, v) => s + v, 0) + generalRevenue;

  return { transactions, studyRoomRevenue, generalRevenue, totalRevenue };
}

module.exports = { fetchMonthlyRevenue, fetchDailyRevenue, fetchDailyDetail };
