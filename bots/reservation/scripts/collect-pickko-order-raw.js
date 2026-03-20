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
 *   - 스터디룸: use_day 기준 예약행 저장 (policy_amount 포함)
 *   - 스터디룸 raw/payment 정보는 같은 날 daily detail 행과 매칭되면 보강
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

const targetDate = getArg('date');
const asJson = argv.includes('--json');
const noStore = argv.includes('--no-store');

if (!targetDate) {
  console.error('❌ --date=YYYY-MM-DD 가 필요합니다.');
  process.exit(1);
}

function buildEntryKey(parts) {
  return parts.map((part) => String(part || '')).join('|');
}

function matchRoomPolicyToDirect(policyRow, roomTransactions) {
  return roomTransactions.find((tx) =>
    tx.roomDetail &&
    tx.roomDetail.useDate === policyRow.useDate &&
    tx.roomDetail.startTime === policyRow.useStartTime &&
    tx.roomDetail.endTime === policyRow.useEndTime &&
    tx.roomDetail.roomType === policyRow.roomType &&
    tx.roomDetail.memberName === policyRow.memberName
  ) || null;
}

async function scrapeOrderDetail(page, href) {
  const url = href.startsWith('http') ? href : `https://pickkoadmin.com${href}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1000);
  return await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    const extractTimestamp = (label) => {
      const idx = text.indexOf(label);
      if (idx < 0) return null;
      const rest = text.slice(idx + label.length).trim();
      const match = rest.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      return match ? match[0] : null;
    };
    const extractWord = (label) => {
      const idx = text.indexOf(label);
      if (idx < 0) return null;
      const rest = text.slice(idx + label.length).trim();
      return rest.split(' ')[0] || null;
    };
    return {
      orderAt: extractTimestamp('주문일시'),
      payType: extractWord('결제타입'),
      payDevice: extractWord('결제기기'),
      status: extractWord('주문상태'),
      memo: extractWord('주문메모'),
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
    const roomTransactions = [];

    for (const tx of detail.transactions || []) {
      const hrefRow = hrefByNo.get(tx.no);
      const extra = hrefRow?.href ? await scrapeOrderDetail(detailPage, hrefRow.href) : {};

      if (tx.studyRoom) {
        roomTransactions.push({
          ...tx,
          detailHref: hrefRow?.href || null,
          orderAt: extra.orderAt || null,
          payType: extra.payType || null,
          payDevice: extra.payDevice || null,
          memo: extra.memo || null,
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
        roomCount: policyRows.length,
      },
      rows: [...generalRows, ...policyRows],
    };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

(async () => {
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
  console.log(`  스터디룸: ${result.summary.roomCount}건`);
  console.log(`  저장: ${noStore ? '건너뜀' : `${storedRows.length}건 조회 확인`}`);
})().catch((error) => {
  console.error(`❌ 수집 실패: ${error.message}`);
  process.exit(1);
});
