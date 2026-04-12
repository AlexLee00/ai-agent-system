#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { publishReservationAlert } = require('../../lib/alert-client');
const { getAllNaverKeys } = require('../../lib/db');
const { maskPhone, maskName } = require('../../lib/formatting');
const {
  getTodayKST,
  buildDailyAuditReport,
} = require('../../lib/daily-report-helpers');
const shadow = require('../../../../packages/core/lib/shadow-mode');
const { IS_OPS } = require('../../../../packages/core/lib/env');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = IS_OPS ? 'ops' : 'dev';

function collectNaverKeys() {
  return getAllNaverKeys();
}

async function shadowEvalManualEntries(manualEntries: any[], today: string) {
  const count = manualEntries.length;
  const ruleEngine = (input: any) => {
    if (input.count <= 1) return { decision: 'low', reason: '수동 예약 1건 이하 — 통상 범위' };
    if (input.count <= 3) return { decision: 'medium', reason: `수동 예약 ${input.count}건 — 주의 필요` };
    return { decision: 'high', reason: `수동 예약 ${input.count}건 — 다수 발생` };
  };

  const llmPrompt = [
    '스터디카페 픽코 시스템의 당일 감사를 수행합니다.',
    '수동 등록 예약 = 전화/방문 예약 (네이버 자동 등록 아님).',
    '입력된 수동 예약 목록을 분석하여 심각도를 판단하세요.',
    '',
    '판단 기준:',
    '- low: 1건 이하, 일반 방문 예약으로 보임',
    '- medium: 2~3건, 수동 처리가 필요하나 비정상적이지 않음',
    '- high: 4건 이상 또는 동일 고객 반복 예약, 비정상 패턴 의심',
    '',
    '반드시 JSON으로만 답하세요:',
    '{"decision": "low|medium|high", "reasoning": "판단 이유 (한국어)", "action_needed": true|false}',
  ].join('\n');

  const sanitizedEntries = manualEntries.map((e) => ({
    date: e.date,
    time: `${e.start || '?'}~${e.end || '?'}`,
    room: e.room || '',
    amount: e.amount || 0,
  }));

  const result = await shadow.evaluate({
    team: 'ska',
    context: 'manual_entry_severity',
    input: { count, entries: sanitizedEntries, date: today },
    ruleEngine,
    llmPrompt,
    mode: 'shadow',
  });

  log(`  [Shadow] 심각도 규칙=${result.action?.decision || '?'} LLM=${result.shadow?.decision || 'N/A'} 일치=${result.match}`);
  if (result.shadow?.reasoning) {
    log(`  [Shadow] LLM 이유: ${result.shadow.reasoning}`);
  }
}

async function main() {
  const today = getTodayKST();
  log(`\n🔍 픽코 일일 감사 시작: ${today} (MODE=${MODE})`);

  let browser: any;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    log('\n[2단계] 당일 접수 예약 일괄 조회');
    const { entries: pickkoEntries, fetchOk } = await fetchPickkoEntries(page, today, {
      sortBy: 'sd_regdate',
      receiptDate: today,
      statusKeyword: '',
    });
    log(`📋 당일 접수: ${pickkoEntries.length}건 (fetchOk=${fetchOk})`);
    for (const e of pickkoEntries) {
      log(`  • ${maskName(e.name)} ${maskPhone(e.phoneRaw)} | ${e.date} ${e.start}~${e.end} | ${e.room} | 접수: ${e.receiptText.slice(0, 16)}`);
    }

    log('\n[3단계] naver-seen.json 네이버 예약 키 비교');
    const autoKeys = await collectNaverKeys();
    log(`📋 naver-seen 네이버 예약 키 수: ${autoKeys.size}개`);

    const autoMatched: any[] = [];
    const manualEntries: any[] = [];

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

    log('\n[4단계] 텔레그램 리포트 발송');

    const total = pickkoEntries.length;
    const autoCount = autoMatched.length;
    const manualCount = manualEntries.length;

    if (manualCount > 0) {
      try {
        await shadowEvalManualEntries(manualEntries, today);
      } catch (e: any) {
        log(`⚠️ Shadow Mode 평가 실패 (무시): ${e.message}`);
      }
    }

    const report = buildDailyAuditReport(today, pickkoEntries, autoMatched, manualEntries);
    log('\n' + report);
    publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: report });
    log('\n✅ 픽코 일일 감사 완료');

    try {
      const rag = require('../../../../packages/core/lib/rag-safe');
      const { storeReservationAuditSummary } = require('../../../../packages/core/lib/reservation-rag');
      await storeReservationAuditSummary(rag, {
        date: today,
        total,
        autoCount,
        manualCount,
        sourceBot: 'audit',
      });
      log('✅ [RAG] 일간 예약 감사 요약 저장 완료');
    } catch (e: any) {
      log(`⚠️ [RAG] 예약 감사 요약 저장 실패 (무시): ${e.message}`);
    }

    try {
      const pruned = await shadow.pruneOldLogs(30);
      if (pruned > 0) log(`🧹 shadow_log 정리: ${pruned}건 (30일 초과)`);
    } catch (e: any) {
      log(`⚠️ shadow_log 정리 실패 (무시): ${e.message}`);
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_e) {}
    }
  }
}

module.exports = {
  collectNaverKeys,
  shadowEvalManualEntries,
  main,
};

main().catch((err: any) => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
