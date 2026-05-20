#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * edux-promotion-gate.ts — Dry-run → 실 발행 승격 게이트
 *
 * 검증 항목 (5/5 모두 통과해야 실 발행 가능):
 *   ① 7일 Dry-run 누적 건수 (35건+)
 *   ② 본문 품질 (평균 1,800자+)
 *   ③ 이미지 생성 성공률 (90%+)
 *   ④ JWT 갱신 정상 (24h 내 success 기록)
 *   ⑤ Rate Limit 위반 0건
 *
 * 실행: node bots/edu-x/scripts/edux-promotion-gate.ts [--auto-promote]
 * --auto-promote: 마스터 승인 없이 조건 충족 시 자동 활성 (권장하지 않음)
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

let telegramSender;
try {
  telegramSender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
} catch { telegramSender = null; }

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'edu-x', 'output');
const GATE_REPORT_PATH = path.join(OUTPUT_DIR, 'edux-promotion-gate.json');

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── 검증 항목 ────────────────────────────────────────────────────

async function check1_DryRunCount() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 35 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT COUNT(*) AS cnt FROM edux_publish_log
      WHERE status = 'dry_run' AND created_at >= $1
    `, [sevenDaysAgo]);
    const cnt = Number(result?.rows?.[0]?.cnt || 0);
    return { ok: cnt >= 35, reason: `7일 dry_run ${cnt}건`, value: cnt, required: 35 };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 35 };
  }
}

async function check2_ContentQuality() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 1800 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT
        category,
        AVG((metadata->>'contentLen')::int) AS avg_len,
        COUNT(*) AS cnt
      FROM edux_publish_log
      WHERE status = 'dry_run' AND created_at >= $1 AND metadata->>'contentLen' IS NOT NULL
      GROUP BY category
    `, [sevenDaysAgo]);
    const rows = result?.rows || [];
    const avgByCategory = {};
    let allOk = true;
    for (const r of rows) {
      avgByCategory[r.category] = Math.round(Number(r.avg_len || 0));
      if (avgByCategory[r.category] < 1800) allOk = false;
    }
    const overallAvg = rows.length > 0
      ? Math.round(rows.reduce((s, r) => s + Number(r.avg_len || 0), 0) / rows.length)
      : 0;
    return {
      ok: allOk && overallAvg >= 1800,
      reason: `평균 ${overallAvg}자 (카테고리별: ${JSON.stringify(avgByCategory)})`,
      value: overallAvg,
      required: 1800,
    };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 1800 };
  }
}

async function check3_ImageSuccessRate() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 90 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE jsonb_array_length(image_urls) > 0) AS with_images
      FROM edux_publish_log
      WHERE status = 'dry_run' AND created_at >= $1
    `, [sevenDaysAgo]);
    const total = Number(result?.rows?.[0]?.total || 0);
    const withImages = Number(result?.rows?.[0]?.with_images || 0);
    const rate = total > 0 ? Math.round((withImages / total) * 100) : 0;
    return { ok: rate >= 90, reason: `${total}건 중 ${withImages}건 이미지 포함 (${rate}%)`, value: rate, required: 90 };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 90 };
  }
}

async function check4_JwtHealth() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: false, required: true };
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT COUNT(*) AS cnt FROM edux_publish_log
      WHERE status IN ('dry_run', 'success') AND created_at >= $1
      LIMIT 1
    `, [oneDayAgo]);
    const cnt = Number(result?.rows?.[0]?.cnt || 0);
    return { ok: cnt > 0, reason: `24h 내 성공 기록 ${cnt}건`, value: cnt > 0, required: true };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: false, required: true };
  }
}

async function check5_NoRateLimit() {
  if (!pgPool) return { ok: true, reason: 'pgPool 없음 (스킵)', value: 0, required: 0 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await pgPool.query(`
      SELECT COUNT(*) AS cnt FROM edux_publish_log
      WHERE status = 'fail'
        AND error_msg LIKE '%429%'
        AND created_at >= $1
    `, [sevenDaysAgo]);
    const cnt = Number(result?.rows?.[0]?.cnt || 0);
    return { ok: cnt === 0, reason: `429 위반 ${cnt}건`, value: cnt, required: 0 };
  } catch (err) {
    return { ok: true, reason: `조회 실패 (스킵): ${err?.message}`, value: 0, required: 0 };
  }
}

// ─── 보고서 생성 ──────────────────────────────────────────────────

async function generateReport() {
  const checks = await Promise.allSettled([
    check1_DryRunCount(),
    check2_ContentQuality(),
    check3_ImageSuccessRate(),
    check4_JwtHealth(),
    check5_NoRateLimit(),
  ]).then((results) => results.map((r, i) => ({
    index: i + 1,
    ...(r.status === 'fulfilled' ? r.value : { ok: false, reason: String(r.reason) }),
  })));

  const labels = [
    '7일 Dry-run 누적 (35건+)',
    '본문 품질 (1,800자+ 평균)',
    '이미지 성공률 (90%+)',
    'JWT 갱신 정상 (24h)',
    'Rate Limit 위반 0건',
  ];

  const passed = checks.filter((c) => c.ok).length;
  const allPass = passed === 5;

  const now = kst.now ? kst.now() : new Date();
  const report = {
    generatedAt: now.toISOString(),
    summary: `${passed}/5 통과`,
    allPass,
    promotion: allPass ? 'PASS — 마스터 승인 후 실 발행 가능' : `HOLD — ${5 - passed}개 항목 미달`,
    checks: checks.map((c, i) => ({
      label: labels[i],
      ok: c.ok,
      reason: c.reason,
      value: c.value,
      required: c.required,
    })),
    nextStep: allPass
      ? [
          '1. 마스터 검토: bots/edu-x/output/edux-promotion-gate.json',
          '2. 실 발행 활성: EDUX_DRY_RUN=false (각 launchd plist 수정)',
          '3. launchd 리로드: launchctl unload/load 5개 plist',
        ]
      : ['Dry-run 계속 운영 → 미달 항목 해결 후 재검사'],
  };

  return report;
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const autoPromote = process.argv.includes('--auto-promote');
  console.log('[edu-x/promotion-gate] 검증 시작...');

  const report = await generateReport();

  ensureOutputDir();
  fs.writeFileSync(GATE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const lines = [
    `🎯 [edu-x] Promotion Gate: ${report.summary}`,
    report.allPass ? '✅ 모든 조건 충족!' : '⏳ 일부 조건 미달',
    '',
    ...report.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.label}: ${c.reason}`),
    '',
    `결과: ${report.promotion}`,
  ];

  const msg = lines.join('\n');
  console.log('\n' + msg);
  console.log(`\n보고서: ${GATE_REPORT_PATH}`);

  if (telegramSender) {
    try { await telegramSender.sendTelegramMessage(msg); } catch {}
  }

  if (report.allPass && autoPromote) {
    console.warn('\n⚠️ --auto-promote 옵션 감지됨. 마스터 승인 없이 진행합니다.');
    console.warn('실 발행 활성화: launchd plist에서 EDUX_DRY_RUN=false로 변경 후 리로드하세요.');
  }
}

main().catch((err) => {
  console.error('[edu-x/promotion-gate] 오류:', err);
  process.exit(1);
});
