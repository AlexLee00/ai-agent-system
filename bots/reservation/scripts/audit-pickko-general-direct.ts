#!/usr/bin/env node
'use strict';

/**
 * audit-pickko-general-direct.ts
 *
 * 목적:
 *   reservation.daily_summary에 저장된 derived general_revenue 와
 *   Pickko 일별 상세에서 직접 파싱한 direct generalRevenue 를 비교한다.
 *
 * 사용 예:
 *   PICKKO_HEADLESS=1 node dist/ts-runtime/bots/reservation/scripts/audit-pickko-general-direct.js --from=2025-10-01 --to=2026-03-20
 *   PICKKO_HEADLESS=1 node dist/ts-runtime/bots/reservation/scripts/audit-pickko-general-direct.js --date=2026-02-01
 *   PICKKO_HEADLESS=1 node dist/ts-runtime/bots/reservation/scripts/audit-pickko-general-direct.js --from=2025-10-01 --to=2026-03-20 --limit=20 --json
 */

const puppeteer = require('puppeteer');
const path = require('path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');
const { fetchDailyDetail } = require('../lib/pickko-stats');
const { delay } = require('../lib/utils');

type CandidateRow = {
  date: string;
  pickko_study_room: number | null;
  general_revenue: number | null;
  room_amounts_json: string | Record<string, unknown> | null;
};

type CandidateQueryArgs = {
  fromDate: string;
  toDate: string;
  exactDate: string | null;
  limit: number;
};

type AuditResult = {
  date: string;
  detailTotalRevenue: number;
  stored: {
    generalRevenue: number;
    studyRoomRevenue: number;
    roomAmounts: Record<string, unknown>;
  };
  direct: {
    generalRevenue: number;
    studyRoomRevenue: number;
    studyRoomRevenueByLabel: Record<string, unknown>;
    transactionCount: number;
    generalTransactions: Array<Record<string, unknown>>;
    roomTransactions: Array<Record<string, unknown>>;
  };
  deltas: {
    generalRevenue: number;
    studyRoomRevenue: number;
    totalGapAgainstStored: number;
    totalGapAgainstDirect: number;
  };
};

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');

function getArg(name) {
  const match = argv.find((item) => item.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

function won(value) {
  return `${Number(value || 0).toLocaleString('ko-KR')}원`;
}

function sumObjectValues(obj: Record<string, unknown> | null | undefined): number {
  if (!obj || typeof obj !== 'object') return 0;
  return Object.values(obj).reduce<number>((sum, value) => sum + Number(value || 0), 0);
}

function parseRoomAmounts(roomAmountsJson: CandidateRow['room_amounts_json']): Record<string, unknown> {
  if (!roomAmountsJson) return {};
  if (typeof roomAmountsJson === 'object') return roomAmountsJson;
  try {
    return JSON.parse(roomAmountsJson) as Record<string, unknown>;
  } catch (_) {
    return {};
  }
}

async function loadCandidateRows({ fromDate, toDate, exactDate, limit }: CandidateQueryArgs): Promise<CandidateRow[]> {
  if (exactDate) {
    return pgPool.query('reservation', `
      SELECT
        date::text AS date,
        pickko_study_room,
        general_revenue,
        room_amounts_json
      FROM daily_summary
      WHERE date = $1
    `, [exactDate]);
  }

  return pgPool.query('reservation', `
    SELECT
      date::text AS date,
      pickko_study_room,
      general_revenue,
      room_amounts_json
    FROM daily_summary
    WHERE date BETWEEN $1 AND $2
    ORDER BY date
    LIMIT $3
  `, [fromDate, toDate, limit]);
}

async function main() {
  const exactDate = getArg('date');
  const fromDate = exactDate || getArg('from') || '2025-10-01';
  const toDate = exactDate || getArg('to') || '2026-03-20';
  const limit = Number(getArg('limit') || (exactDate ? 1 : 20));

  const candidates = await loadCandidateRows({ fromDate, toDate, exactDate, limit });
  if (!candidates.length) {
    const empty = { ok: true, rows: [], message: '대상 날짜 없음' };
    if (AS_JSON) {
      console.log(JSON.stringify(empty, null, 2));
    } else {
      console.log('대상 날짜가 없습니다.');
    }
    await pgPool.closeAll();
    return;
  }

  const { pickko_id, pickko_pw } = loadSecrets();
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const results: AuditResult[] = [];

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, console.log);
    await loginToPickko(page, pickko_id, pickko_pw, delay);

    for (const row of candidates) {
      const detail = await fetchDailyDetail(page, row.date);
      const storedRoomAmounts = parseRoomAmounts(row.room_amounts_json);
      const directRoomTotal = sumObjectValues(detail.studyRoomRevenue);
      const storedRoomTotal = Number(row.pickko_study_room || 0);
      const storedGeneral = Number(row.general_revenue || 0);
      const directGeneral = Number(detail.generalRevenue || 0);
      const detailTotalRevenue = Number(detail.totalRevenue || 0);

      results.push({
        date: row.date,
        detailTotalRevenue,
        stored: {
          generalRevenue: storedGeneral,
          studyRoomRevenue: storedRoomTotal,
          roomAmounts: storedRoomAmounts,
        },
        direct: {
          generalRevenue: directGeneral,
          studyRoomRevenue: directRoomTotal,
          studyRoomRevenueByLabel: detail.studyRoomRevenue || {},
          transactionCount: detail.transactions.length,
          generalTransactions: detail.transactions
            .filter((tx) => !tx.studyRoom)
            .map((tx) => ({
              no: tx.no,
              description: tx.description,
              amount: tx.netRevenue,
              ticketType: tx.generalTicket?.ticketType || null,
              productHours: tx.generalTicket?.productHours || null,
              productDays: tx.generalTicket?.productDays || null,
              memberHint: tx.generalTicket?.memberHint || null,
              startDate: tx.generalTicket?.startDate || null,
              endDate: tx.generalTicket?.endDate || null,
              isPeriodPass: tx.generalTicket?.isPeriodPass || false,
            })),
          roomTransactions: detail.transactions
            .filter((tx) => !!tx.studyRoom)
            .map((tx) => ({
              no: tx.no,
              description: tx.description,
              amount: tx.netRevenue,
              roomLabel: tx.roomDetail?.roomLabel || tx.studyRoom || null,
              roomType: tx.roomDetail?.roomType || null,
              useDate: tx.roomDetail?.useDate || null,
              startTime: tx.roomDetail?.startTime || null,
              endTime: tx.roomDetail?.endTime || null,
              memberName: tx.roomDetail?.memberName || null,
            })),
        },
        deltas: {
          generalRevenue: directGeneral - storedGeneral,
          studyRoomRevenue: directRoomTotal - storedRoomTotal,
          totalGapAgainstStored: detailTotalRevenue - (storedGeneral + storedRoomTotal),
          totalGapAgainstDirect: detailTotalRevenue - (directGeneral + directRoomTotal),
        },
      });
    }
  } finally {
    try { await browser.close(); } catch (_) {}
    await pgPool.closeAll();
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      ok: true,
      fromDate,
      toDate,
      exactDate,
      limit,
      rows: results,
    }, null, 2));
    return;
  }

  const lines = [];
  lines.push('📊 Pickko direct vs derived generalRevenue audit');
  lines.push('');
  lines.push(`기간: ${exactDate || `${fromDate} ~ ${toDate}`}`);
  lines.push(`건수: ${results.length}`);

  for (const row of results) {
    lines.push('');
    lines.push(`■ ${row.date}`);
    lines.push(`  detail total: ${won(row.detailTotalRevenue)}`);
    lines.push(`  stored general: ${won(row.stored.generalRevenue)} | direct general: ${won(row.direct.generalRevenue)} | Δ ${won(row.deltas.generalRevenue)}`);
    lines.push(`  stored room: ${won(row.stored.studyRoomRevenue)} | direct room: ${won(row.direct.studyRoomRevenue)} | Δ ${won(row.deltas.studyRoomRevenue)}`);
    lines.push(`  txCount: ${row.direct.transactionCount}`);
    lines.push(`  direct room labels: ${JSON.stringify(row.direct.studyRoomRevenueByLabel)}`);
  }

  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`❌ audit 실패: ${message}`);
  process.exit(1);
});
