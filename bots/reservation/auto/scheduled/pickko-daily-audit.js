#!/usr/bin/env node

/**
 * pickko-daily-audit.js — 당일 픽코 예약 사후 감사
 *
 * 목적: 픽코 당일 접수 예약 중 네이버 auto 외 전화/수동 예약 탐지 → 텔레그램 리포트
 * 실행: node src/pickko-daily-audit.js
 * 스케줄: 매일 22:00 (launchd: ai.ska.pickko-daily-audit)
 */

const puppeteer = require('puppeteer');
const path = require('path');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { sendTelegram } = require('../../lib/telegram');
const { getAllNaverKeys } = require('../../lib/db');
const { maskPhone, maskName } = require('../../lib/formatting');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = (process.env.MODE || 'ops').toLowerCase();

// KST 기준 오늘 날짜 (YYYY-MM-DD)
function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// DB에서 "네이버 경유" 예약 키 수집 (collectNaverKeys 대체)
function collectNaverKeys() {
  return getAllNaverKeys();
}

async function main() {
  const today = getTodayKST();
  log(`\n🔍 픽코 일일 감사 시작: ${today} (MODE=${MODE})`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ──── 1단계: 로그인 ────
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    // ──── 2단계: 당일 접수 예약 일괄 조회 ────
    // sortBy=sd_regdate: 접수일시 기준 내림차순 → receiptDate=today 행만 수집
    // statusKeyword='': 결제완료/환불 등 전체 상태 수집
    log('\n[2단계] 당일 접수 예약 일괄 조회');
    const { entries: pickkoEntries, fetchOk } = await fetchPickkoEntries(page, today, {
      sortBy: 'sd_regdate',
      receiptDate: today,
      statusKeyword: ''
    });
    log(`📋 당일 접수: ${pickkoEntries.length}건 (fetchOk=${fetchOk})`);
    for (const e of pickkoEntries) {
      log(`  • ${maskName(e.name)} ${maskPhone(e.phoneRaw)} | ${e.date} ${e.start}~${e.end} | ${e.room} | 접수: ${e.receiptText.slice(0, 16)}`);
    }

    // ──── 3단계: naver-seen.json 네이버 예약 키와 비교 ────
    log('\n[3단계] naver-seen.json 네이버 예약 키 비교');
    const autoKeys = collectNaverKeys();
    log(`📋 naver-seen 네이버 예약 키 수: ${autoKeys.size}개`);

    const autoMatched = [];
    const manualEntries = [];

    for (const e of pickkoEntries) {
      const key = `${e.phoneRaw}|${e.date}|${e.start}`;
      if (autoKeys.has(key)) {
        autoMatched.push(e);
        log(`  ✅ auto: ${key}`);
      } else {
        manualEntries.push({ ...e, key });
        log(`  ⚠️ manual: ${key}`);
      }
    }

    // ──── 4단계: 텔레그램 리포트 ────
    log('\n[4단계] 텔레그램 리포트 발송');

    const total = pickkoEntries.length;
    const autoCount = autoMatched.length;
    const manualCount = manualEntries.length;

    let report;
    if (total === 0) {
      report = `📊 픽코 일일 감사 — ${today}\n\n당일 등록된 예약이 없습니다.`;
    } else if (manualCount === 0) {
      report = `📊 픽코 일일 감사 — ${today}\n\n✅ 당일 픽코 등록 ${total}건 모두 auto\n네이버 예약 자동 등록 정상 처리됨`;
    } else {
      const fmtPhone = (raw) => raw.length === 11
        ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`
        : raw;

      report = `📊 픽코 일일 감사 — ${today}\n\n`;
      report += `총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건\n\n`;
      report += `⚠️ 수동(전화/직접) 등록 항목:\n`;
      report += `━━━━━━━━━━━━━━━\n`;
      for (const e of manualEntries) {
        report += `• ${e.name || '(이름없음)'} ${e.phoneRaw ? fmtPhone(e.phoneRaw) : '(번호없음)'}\n`;
        report += `  ${e.date} ${e.start}~${e.end} ${e.room || ''}\n`;
      }
    }

    log('\n' + report);
    sendTelegram(report);
    log('\n✅ 픽코 일일 감사 완료');

  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
