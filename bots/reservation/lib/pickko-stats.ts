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
const { normalizeStudyRoomKey } = require('./study-room-pricing');

type MonthlyRevenueRow = {
  date: string;
  netRevenue: number;
  refundAmount: number;
  grossRevenue: number;
};

type GeneralTicketDetail = {
  rawDescription: string;
  productHours: number | null;
  productDays: number | null;
  ticketType: string;
  memberHint: string | null;
  startDate: string | null;
  endDate: string | null;
  isPeriodPass: boolean;
};

type StudyRoomDetail = {
  rawDescription: string;
  roomLabel: string | null;
  roomType: string | null;
  useDate: string | null;
  startTime: string | null;
  endTime: string | null;
  memberName: string | null;
};

type DailyTransaction = {
  no: number;
  description: string;
  netRevenue: number;
  studyRoom: string | null;
  generalTicket: GeneralTicketDetail | null;
  roomDetail: StudyRoomDetail | null;
};

type DailyDetail = {
  transactions: DailyTransaction[];
  studyRoomRevenue: Record<string, number>;
  generalRevenue: number;
  totalRevenue: number;
};

function normalizeStudyRoomLabel(description: unknown): string | null {
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

function normalizeTicketType(hours: unknown, description: unknown, amount: unknown): string {
  const text = String(description || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.includes('기간권')) {
    if (Number(amount || 0) === 80000) return '기간권-14일';
    if (Number(amount || 0) === 150000) return '기간권-28일';
    const dayMatch = text.match(/(\d+)\s*일/);
    return dayMatch ? `기간권-${dayMatch[1]}일` : '기간권';
  }

  const hour = Number(hours || 0);
  if ([1, 2, 3, 4, 6, 8, 14].includes(hour)) return `일회권-${hour}시간`;
  if ([30, 50].includes(hour)) return `시간권-${hour}시간`;
  return hour > 0 ? `기타-${hour}시간` : '미분류';
}

function parseGeneralTicketDescription(description: unknown, amount = 0): GeneralTicketDetail {
  const text = String(description || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return {
      rawDescription: '',
      productHours: null,
      productDays: null,
      ticketType: '미분류',
      memberHint: null,
      startDate: null,
      endDate: null,
      isPeriodPass: false,
    };
  }

  const baseMatch = text.match(/(\d+)(시간|일)\((\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})\)\s*([^()]+?)\s*\(([^)]+)\)/);
  if (baseMatch) {
    const value = Number(baseMatch[1]);
    const unit = baseMatch[2];
    return {
      rawDescription: text,
      productHours: unit === '시간' ? value : null,
      productDays: unit === '일' ? value : null,
      ticketType: unit === '시간'
        ? normalizeTicketType(value, text, amount)
        : normalizeTicketType(null, `기간권 ${value}일`, amount),
      memberHint: baseMatch[6],
      startDate: baseMatch[3],
      endDate: baseMatch[4],
      isPeriodPass: unit === '일' || text.includes('기간권'),
    };
  }

  const periodMatch = text.match(/기간권\s*\(([^)]+)\)/);
  if (periodMatch) {
    return {
      rawDescription: text,
      productHours: null,
      productDays: Number((text.match(/(\d+)\s*일/) || [])[1] || 0) || null,
      ticketType: normalizeTicketType(null, text, amount),
      memberHint: periodMatch[1],
      startDate: null,
      endDate: null,
      isPeriodPass: true,
    };
  }

  return {
    rawDescription: text,
    productHours: null,
    productDays: null,
    ticketType: normalizeTicketType(null, text, amount),
    memberHint: (text.match(/\(([^)]+)\)\s*$/) || [])[1] || null,
    startDate: null,
    endDate: null,
    isPeriodPass: text.includes('기간권'),
  };
}

function parseStudyRoomDescription(description: unknown, defaultYear: number | null = null): StudyRoomDetail {
  const text = String(description || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) {
    return {
      rawDescription: '',
      roomLabel: null,
      roomType: null,
      useDate: null,
      startTime: null,
      endTime: null,
      memberName: null,
    };
  }

  const roomLabel = normalizeStudyRoomLabel(text);
  const roomType = normalizeStudyRoomKey(roomLabel || text);
  const timeMatch = text.match(/(\d{2})월\s+(\d{2})일\s+(\d{2})시\s+(\d{2})분\s+~\s+(\d{2})시\s+(\d{2})분\s+\(([^)]+)\)/);

  if (!timeMatch) {
    return {
      rawDescription: text,
      roomLabel,
      roomType,
      useDate: null,
      startTime: null,
      endTime: null,
      memberName: (text.match(/\(([^)]+)\)\s*$/) || [])[1] || null,
    };
  }

  const year = defaultYear || new Date().getFullYear();
  return {
    rawDescription: text,
    roomLabel,
    roomType,
    useDate: `${year}-${timeMatch[1]}-${timeMatch[2]}`,
    startTime: `${timeMatch[3]}:${timeMatch[4]}`,
    endTime: `${timeMatch[5]}:${timeMatch[6]}`,
    memberName: timeMatch[7],
  };
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
async function fetchMonthlyRevenue(page: any, year: number, month: number): Promise<MonthlyRevenueRow[]> {
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
async function fetchDailyRevenue(page: any, date: string): Promise<MonthlyRevenueRow | null> {
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
async function fetchDailyDetail(page: any, date: string): Promise<DailyDetail> {
  const url = `https://pickkoadmin.com/manager/statistic/day/${date}.html`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  const targetYear = Number(String(date || '').slice(0, 4)) || new Date().getFullYear();

  const transactions: DailyTransaction[] = await page.evaluate((defaultYear: number) => {
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

    const normalizeTicketType = (hours, description, amount) => {
      const text = String(description || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.includes('기간권')) {
        if (Number(amount || 0) === 80000) return '기간권-14일';
        if (Number(amount || 0) === 150000) return '기간권-28일';
        const dayMatch = text.match(/(\d+)\s*일/);
        return dayMatch ? `기간권-${dayMatch[1]}일` : '기간권';
      }

      const hour = Number(hours || 0);
      if ([1, 2, 3, 4, 6, 8, 14].includes(hour)) return `일회권-${hour}시간`;
      if ([30, 50].includes(hour)) return `시간권-${hour}시간`;
      return hour > 0 ? `기타-${hour}시간` : '미분류';
    };

    const parseGeneralTicketDescription = (description, amount = 0) => {
      const text = String(description || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        return {
          rawDescription: '',
          productHours: null,
          productDays: null,
          ticketType: '미분류',
          memberHint: null,
          startDate: null,
          endDate: null,
          isPeriodPass: false,
        };
      }

      const baseMatch = text.match(/(\d+)(시간|일)\((\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})\)\s*([^()]+?)\s*\(([^)]+)\)/);
      if (baseMatch) {
        const value = Number(baseMatch[1]);
        const unit = baseMatch[2];
        return {
          rawDescription: text,
          productHours: unit === '시간' ? value : null,
          productDays: unit === '일' ? value : null,
          ticketType: unit === '시간'
            ? normalizeTicketType(value, text, amount)
            : normalizeTicketType(null, `기간권 ${value}일`, amount),
          memberHint: baseMatch[6],
          startDate: baseMatch[3],
          endDate: baseMatch[4],
          isPeriodPass: unit === '일' || text.includes('기간권'),
        };
      }

      const periodMatch = text.match(/기간권\s*\(([^)]+)\)/);
      if (periodMatch) {
        return {
          rawDescription: text,
          productHours: null,
          productDays: Number((text.match(/(\d+)\s*일/) || [])[1] || 0) || null,
          ticketType: normalizeTicketType(null, text, amount),
          memberHint: periodMatch[1],
          startDate: null,
          endDate: null,
          isPeriodPass: true,
        };
      }

      return {
        rawDescription: text,
        productHours: null,
        productDays: null,
        ticketType: normalizeTicketType(null, text, amount),
        memberHint: (text.match(/\(([^)]+)\)\s*$/) || [])[1] || null,
        startDate: null,
        endDate: null,
        isPeriodPass: text.includes('기간권'),
      };
    };

    const parseStudyRoomDescription = (description, defaultYear) => {
      const text = String(description || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) {
        return {
          rawDescription: '',
          roomLabel: null,
          roomType: null,
          useDate: null,
          startTime: null,
          endTime: null,
          memberName: null,
        };
      }

      const roomLabel = normalizeStudyRoomLabel(text);
      const roomType = (() => {
        const normalized = String(roomLabel || text || '')
          .replace(/\u00A0/g, ' ')
          .replace(/\s+/g, '')
          .toUpperCase();
        if (!normalized) return null;
        if (normalized.includes('A1')) return 'A1';
        if (normalized.includes('A2')) return 'A2';
        if (normalized === 'B' || normalized.includes('룸B') || normalized.includes('스터디룸B') || /^B\d*$/.test(normalized)) return 'B';
        return null;
      })();
      const timeMatch = text.match(/(\d{2})월\s+(\d{2})일\s+(\d{2})시\s+(\d{2})분\s+~\s+(\d{2})시\s+(\d{2})분\s+\(([^)]+)\)/);

      if (!timeMatch) {
        return {
          rawDescription: text,
          roomLabel,
          roomType,
          useDate: null,
          startTime: null,
          endTime: null,
          memberName: (text.match(/\(([^)]+)\)\s*$/) || [])[1] || null,
        };
      }

      return {
        rawDescription: text,
        roomLabel,
        roomType,
        useDate: `${defaultYear}-${timeMatch[1]}-${timeMatch[2]}`,
        startTime: `${timeMatch[3]}:${timeMatch[4]}`,
        endTime: `${timeMatch[5]}:${timeMatch[6]}`,
        memberName: timeMatch[7],
      };
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
      const generalTicket = studyRoom ? null : parseGeneralTicketDescription(description, netRevenue);
      const roomDetail = studyRoom ? parseStudyRoomDescription(description, defaultYear) : null;

      return { no: Number(no), description, netRevenue, studyRoom, generalTicket, roomDetail };
    }).filter(Boolean);
  }, targetYear);

  // 룸별·일반 합산
  const studyRoomRevenue: Record<string, number> = {};
  let generalRevenue = 0;

  for (const t of transactions) {
    if (t.studyRoom) {
      studyRoomRevenue[t.studyRoom] = (studyRoomRevenue[t.studyRoom] || 0) + t.netRevenue;
    } else {
      generalRevenue += t.netRevenue;
    }
  }

  const totalRevenue = Object.values(studyRoomRevenue).reduce<number>((s, v) => s + v, 0) + generalRevenue;

  return { transactions, studyRoomRevenue, generalRevenue, totalRevenue };
}

module.exports = {
  fetchMonthlyRevenue,
  fetchDailyRevenue,
  fetchDailyDetail,
  normalizeStudyRoomLabel,
  parseGeneralTicketDescription,
  parseStudyRoomDescription,
  normalizeTicketType,
};
