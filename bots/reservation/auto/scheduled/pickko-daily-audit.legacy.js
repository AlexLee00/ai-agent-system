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
const { publishToMainBot } = require('../../lib/mainbot-client');
const { getAllNaverKeys } = require('../../lib/db');
const { maskPhone, maskName } = require('../../lib/formatting');
const shadow = require('../../../../packages/core/lib/shadow-mode');
const { IS_OPS } = require('../../../../packages/core/lib/env');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = IS_OPS ? 'ops' : 'dev';

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
    const autoKeys = await collectNaverKeys();
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

    // ──── 3-b단계: Shadow Mode — 수동 예약 심각도 AI 판단 ────
    // 기존 동작에 영향 없음. LLM 판단은 shadow_log에만 기록됨.
    if (manualCount > 0) {
      try {
        await _shadowEvalManualEntries(manualEntries, today);
      } catch (e) {
        log(`⚠️ Shadow Mode 평가 실패 (무시): ${e.message}`);
      }
    }

    let report;
    if (total === 0) {
      report = `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n당일 접수 기준 신규 예약이 없습니다.\n오늘 이용 예약이 없다는 뜻은 아닙니다.`;
    } else if (manualCount === 0) {
      report = `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n✅ 당일 접수 ${total}건 모두 auto\n네이버 예약 자동 등록 정상 처리됨`;
    } else {
      const fmtPhone = (raw) => raw.length === 11
        ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`
        : raw;

      report = `📊 픽코 일일 감사 (당일 접수 기준) — ${today}\n\n`;
      report += `총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건\n\n`;
      report += `⚠️ 수동(전화/직접) 등록 항목:\n`;
      report += `━━━━━━━━━━━━━━━\n`;
      for (const e of manualEntries) {
        report += `• ${e.name || '(이름없음)'} ${e.phoneRaw ? fmtPhone(e.phoneRaw) : '(번호없음)'}\n`;
        report += `  ${e.date} ${e.start}~${e.end} ${e.room || ''}\n`;
      }
    }

    log('\n' + report);
    publishToMainBot({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: report });
    log('\n✅ 픽코 일일 감사 완료');

    // ──── RAG: 일간 예약 감사 요약 저장 ────
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
    } catch (e) {
      log(`⚠️ [RAG] 예약 감사 요약 저장 실패 (무시): ${e.message}`);
    }

    // ──── 5단계: Shadow Log 자동 정리 (30일 초과 레코드 삭제) ────
    try {
      const pruned = await shadow.pruneOldLogs(30);
      if (pruned > 0) log(`🧹 shadow_log 정리: ${pruned}건 (30일 초과)`);
    } catch (e) {
      log(`⚠️ shadow_log 정리 실패 (무시): ${e.message}`);
    }

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

// ── Shadow Mode: 수동 예약 심각도 평가 ──────────────────────────────
/**
 * 수동 예약 항목들의 심각도를 Shadow Mode로 평가
 * 규칙: 건수 기반 (low/medium/high)
 * LLM:  Groq가 예약 패턴 종합 판단
 * → shadow_log에 비교 기록 (기존 리포트 발송에 영향 없음)
 */
async function _shadowEvalManualEntries(manualEntries, today) {
  const count = manualEntries.length;

  // 규칙 엔진: 단순 건수 기반 심각도
  const ruleEngine = (input) => {
    if (input.count <= 1) return { decision: 'low',    reason: '수동 예약 1건 이하 — 통상 범위' };
    if (input.count <= 3) return { decision: 'medium', reason: `수동 예약 ${input.count}건 — 주의 필요` };
    return               { decision: 'high',   reason: `수동 예약 ${input.count}건 — 다수 발생` };
  };

  // LLM 시스템 프롬프트
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

  // PII 마스킹된 입력
  const sanitizedEntries = manualEntries.map(e => ({
    date:   e.date,
    time:   `${e.start || '?'}~${e.end || '?'}`,
    room:   e.room   || '',
    amount: e.amount || 0,
  }));

  const result = await shadow.evaluate({
    team:      'ska',
    context:   'manual_entry_severity',
    input:     { count, entries: sanitizedEntries, date: today },
    ruleEngine,
    llmPrompt,
    mode:      'shadow',
  });

  log(`  [Shadow] 심각도 규칙=${result.action?.decision || '?'} LLM=${result.shadow?.decision || 'N/A'} 일치=${result.match}`);
  if (result.shadow?.reasoning) {
    log(`  [Shadow] LLM 이유: ${result.shadow.reasoning}`);
  }
}
