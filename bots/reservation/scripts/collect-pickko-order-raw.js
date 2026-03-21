#!/usr/bin/env node
'use strict';

/**
 * collect-pickko-order-raw.js
 *
 * 목적:
 *   Pickko 관리자에서 날짜 단위 raw order 메타를 수집해 reservation.pickko_order_raw에 저장
 *
 * 기본 저장 규칙:
 *   - 일반석: payment_day 기준 direct 거래행 저장
 *   - 스터디룸(payment): payment_day 기준 direct 거래행 저장
 *   - 스터디룸(use): use_day 기준 예약행 저장 (policy_amount 포함)
 *   - 스터디룸 use/payment 두 축을 같이 저장해 결제 패턴과 이용 패턴을 분리 분석
 *
 * 사용 예:
 *   PICKKO_HEADLESS=1 node bots/reservation/scripts/collect-pickko-order-raw.js --date=2026-03-20
 *   PICKKO_HEADLESS=1 node bots/reservation/scripts/collect-pickko-order-raw.js --date=2026-03-20 --json --no-store
 */

const puppeteer = require('puppeteer');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../lib/pickko');
const { fetchDailyDetail } = require('../lib/pickko-stats');
const { delay } = require('../lib/utils');
const { calcStudyRoomAmount, normalizeStudyRoomKey } = require('../lib/study-room-pricing');
const {
  upsertPickkoOrderRawBatch,
  getPickkoOrderRawByDate,
} = require('../lib/db');

const argv = process.argv.slice(2);

function getArg(name) {
  const match = argv.find((item) => item.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

const asJson = argv.includes('--json');
const noStore = argv.includes('--no-store');

function buildEntryKey(parts) {
  return parts.map((part) => String(part || '')).join('|');
}

function matchRoomPolicyToDirect(policyRow, roomTransactions) {
  return roomTransactions.find((tx) =>
    tx.roomDetail &&
    tx.roomDetail.useDate === policyRow.useDate &&
    tx.roomDetail.startTime === policyRow.useStartTime &&
    tx.roomDetail.endTime === policyRow.useEndTime &&
    normalizeStudyRoomKey(tx.roomDetail.roomType || tx.roomDetail.roomLabel || tx.studyRoom) === policyRow.roomType &&
    tx.roomDetail.memberName === policyRow.memberName
  ) || null;
}

function calcPolicyAmountFromRoomDetail(roomDetail) {
  if (!roomDetail?.roomType || !roomDetail?.startTime || !roomDetail?.endTime) return 0;
  return calcStudyRoomAmount({
    room: roomDetail.roomType,
    start: roomDetail.startTime,
    end: roomDetail.endTime,
  });
}

async function scrapeOrderDetail(page, href) {
  const url = href.startsWith('http') ? href : `https://pickkoadmin.com${href}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  try {
    await page.waitForFunction(() => {
      const text = document.body?.innerText || '';
      return text.includes('주문일시') || text.includes('주문 상세 정보') || text.includes('결제 항목');
    }, { timeout: 5000 });
  } catch (_) {
    // 일부 상세 페이지는 렌더링이 늦거나 라벨 구성이 달라 추가 대기만 하고 진행
  }
  await delay(1200);
  return await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    const labels = ['결제타입', '결제기기', '카드결제금액', '주문메모', '주문상태', '주문일시', '작업로그', '추가 정보'];
    const extractSection = (label) => {
      const idx = text.indexOf(label);
      if (idx < 0) return null;
      const rest = text.slice(idx + label.length).trim();
      let cut = rest.length;
      for (const nextLabel of labels) {
        if (nextLabel === label) continue;
        const nextIdx = rest.indexOf(nextLabel);
        if (nextIdx >= 0 && nextIdx < cut) cut = nextIdx;
      }
      const value = rest.slice(0, cut).trim();
      return value || null;
    };
    const extractTimestamp = (label) => {
      const section = extractSection(label);
      const directMatch = String(section || '').match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      if (directMatch) return directMatch[0];
      const fallback = text.match(new RegExp(`${label}\\s*(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})`));
      return fallback ? fallback[1] : null;
    };
    const extractWord = (label) => {
      const section = extractSection(label);
      if (!section) return null;
      const value = section.split(' ')[0]?.trim();
      if (!value || labels.includes(value)) return null;
      return value;
    };
    const extractMemo = () => {
      const section = extractSection('주문메모');
      if (!section || labels.includes(section)) return null;
      return section;
    };
    const firstTimestamp = text.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)?.[0] || null;
    return {
      orderAt: extractTimestamp('주문일시') || firstTimestamp,
      payType: extractWord('결제타입'),
      payDevice: extractWord('결제기기'),
      status: extractWord('주문상태'),
      memo: extractMemo(),
      url: location.href,
    };
  });
}

async function collectRows(date) {
  const { pickko_id, pickko_pw } = loadSecrets();
  const browser = await puppeteer.launch(getPickkoLaunchOptions());

  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, console.log);
    await loginToPickko(page, pickko_id, pickko_pw, delay);

    const detail = await fetchDailyDetail(page, date);
    const fetched = await fetchPickkoEntries(page, date, { endDate: date, minAmount: 0 });
    const entries = fetched.entries || [];

    const dayUrl = `https://pickkoadmin.com/manager/statistic/day/${date}.html`;
    await page.goto(dayUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1200);

    const rowHrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('table tbody tr')).map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const noText = (tds[0]?.textContent || '').trim();
        const description = (tds[1]?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/^\d+$/.test(noText)) return null;
        const link = Array.from(tr.querySelectorAll('a')).find((a) => (a.textContent || '').includes('결제보기'));
        return {
          no: Number(noText),
          description,
          href: link ? link.getAttribute('href') : null,
        };
      }).filter(Boolean);
    });

    const hrefByNo = new Map(rowHrefs.map((row) => [row.no, row]));
    const detailPage = await browser.newPage();
    detailPage.setDefaultTimeout(30000);
    setupDialogHandler(detailPage, console.log);

    const generalRows = [];
    const paymentRoomRows = [];
    const roomTransactions = [];

    for (const tx of detail.transactions || []) {
      const hrefRow = hrefByNo.get(tx.no);
      const extra = hrefRow?.href ? await scrapeOrderDetail(detailPage, hrefRow.href) : {};

      if (tx.studyRoom) {
        const roomTx = {
          ...tx,
          detailHref: hrefRow?.href || null,
          orderAt: extra.orderAt || null,
          payType: extra.payType || null,
          payDevice: extra.payDevice || null,
          memo: extra.memo || null,
        };
        roomTransactions.push(roomTx);
        paymentRoomRows.push({
          entryKey: buildEntryKey(['payment_day', 'study_room', date, tx.no]),
          sourceDate: date,
          sourceAxis: 'payment_day',
          orderKind: 'study_room',
          transactionNo: tx.no,
          detailHref: hrefRow?.href || null,
          description: tx.description,
          rawAmount: tx.netRevenue,
          paymentAt: extra.orderAt || null,
          payType: extra.payType || null,
          payDevice: extra.payDevice || null,
          memo: extra.memo || null,
          roomLabel: roomTx.roomDetail?.roomLabel || roomTx.studyRoom || null,
          roomType: normalizeStudyRoomKey(roomTx.roomDetail?.roomType || roomTx.roomDetail?.roomLabel || roomTx.studyRoom),
          useDate: roomTx.roomDetail?.useDate || null,
          useStartTime: roomTx.roomDetail?.startTime || null,
          useEndTime: roomTx.roomDetail?.endTime || null,
          memberName: roomTx.roomDetail?.memberName || null,
          policyAmount: calcPolicyAmountFromRoomDetail(roomTx.roomDetail),
          amountMatch: roomTx.roomDetail ? (Number(tx.netRevenue || 0) === calcPolicyAmountFromRoomDetail(roomTx.roomDetail) ? 1 : 0) : null,
          amountDelta: roomTx.roomDetail ? Number(tx.netRevenue || 0) - calcPolicyAmountFromRoomDetail(roomTx.roomDetail) : null,
        });
      } else {
        generalRows.push({
          entryKey: buildEntryKey(['payment_day', 'general', date, tx.no]),
          sourceDate: date,
          sourceAxis: 'payment_day',
          orderKind: 'general',
          transactionNo: tx.no,
          detailHref: hrefRow?.href || null,
          description: tx.description,
          rawAmount: tx.netRevenue,
          paymentAt: extra.orderAt || null,
          payType: extra.payType || null,
          payDevice: extra.payDevice || null,
          memo: extra.memo || null,
          ticketType: tx.generalTicket?.ticketType || null,
          productHours: tx.generalTicket?.productHours || null,
          productDays: tx.generalTicket?.productDays || null,
          memberHint: tx.generalTicket?.memberHint || null,
          validityStart: tx.generalTicket?.startDate || null,
          validityEnd: tx.generalTicket?.endDate || null,
        });
      }
    }

    const policyRows = entries.map((entry) => {
      const roomType = normalizeStudyRoomKey(entry.room);
      const useDate = entry.date || date;
      const useStartTime = entry.start || null;
      const useEndTime = entry.end || null;
      const policyAmount = calcStudyRoomAmount(entry);
      const matched = matchRoomPolicyToDirect({
        roomType,
        useDate,
        useStartTime,
        useEndTime,
        memberName: entry.name,
      }, roomTransactions);
      const rawAmount = matched ? Number(matched.netRevenue || 0) : Number(entry.amount || 0);
      return {
        entryKey: buildEntryKey(['use_day', 'study_room', useDate, roomType, useStartTime, useEndTime, entry.name]),
        sourceDate: useDate,
        sourceAxis: 'use_day',
        orderKind: 'study_room',
        transactionNo: matched?.no || null,
        detailHref: matched?.detailHref || null,
        description: matched?.description || `${entry.room} ${useDate} ${useStartTime}~${useEndTime} (${entry.name})`,
        rawAmount,
        paymentAt: matched?.orderAt || null,
        payType: matched?.payType || null,
        payDevice: matched?.payDevice || null,
        memo: matched?.memo || null,
        roomLabel: matched?.roomDetail?.roomLabel || null,
        roomType,
        useDate,
        useStartTime,
        useEndTime,
        memberName: entry.name,
        policyAmount,
        amountMatch: rawAmount === policyAmount ? 1 : 0,
        amountDelta: rawAmount - policyAmount,
      };
    });

    await detailPage.close();

    return {
      date,
      summary: {
        pickkoTotal: detail.totalRevenue,
        directGeneralRevenue: detail.generalRevenue,
        directStudyRoomRevenue: Object.values(detail.studyRoomRevenue || {}).reduce((sum, value) => sum + Number(value || 0), 0),
        generalCount: generalRows.length,
        paymentRoomCount: paymentRoomRows.length,
        roomCount: policyRows.length,
      },
      rows: [...generalRows, ...paymentRoomRows, ...policyRows],
    };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

async function main() {
  const targetDate = getArg('date');
  if (!targetDate) {
    console.error('❌ --date=YYYY-MM-DD 가 필요합니다.');
    process.exit(1);
  }

  const result = await collectRows(targetDate);

  if (!noStore) {
    await upsertPickkoOrderRawBatch(result.rows);
  }

  const storedRows = noStore ? result.rows : await getPickkoOrderRawByDate(targetDate);
  if (asJson) {
    console.log(JSON.stringify({
      ok: true,
      stored: !noStore,
      ...result,
      storedRowCount: storedRows.length,
      storedRows,
    }, null, 2));
    return;
  }

  console.log(`📦 Pickko raw order 수집 완료 (${targetDate})`);
  console.log(`  일반석: ${result.summary.generalCount}건`);
  console.log(`  스터디룸(payment): ${result.summary.paymentRoomCount}건`);
  console.log(`  스터디룸(use): ${result.summary.roomCount}건`);
  console.log(`  저장: ${noStore ? '건너뜀' : `${storedRows.length}건 조회 확인`}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ 수집 실패: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  collectRows,
  matchRoomPolicyToDirect,
  calcPolicyAmountFromRoomDetail,
};
