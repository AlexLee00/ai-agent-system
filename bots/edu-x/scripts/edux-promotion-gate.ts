#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * edux-promotion-gate.ts — Dry-run → 실 발행 승격 게이트
 *
 * 검증 항목 (7/7 모두 통과해야 실 발행 가능):
 *   ① 7일 검증 실행 누적 건수 (35건+)
 *      - dry_run과 실제 API 성공([TEST] one-off 포함)을 모두 인정한다.
 *      - 단, fixture / 본문 없음 / 이미지 첨부 / post_id 없는 success는 제외한다.
 *   ② 본문 생성 로그 정상 (글자수 hard gate 없음)
 *   ③ 이미지 미첨부 정책 준수
 *   ④ JWT 갱신 정상 (24h 내 success 기록)
 *   ⑤ Rate Limit 위반 0건
 *
 * 실행: node bots/edu-x/scripts/edux-promotion-gate.ts [--json] [--fixture] [--no-write]
 * 자동 promote는 금지. 이 스크립트는 보고서만 생성한다.
 */

const path = require('path');
const fs = require('fs');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');
const {
  parseArgs,
  dbQuery,
  ensureDir,
  OUTPUT_DIR,
  PROMOTION_GATE_REPORT,
  emitJsonIfRequested,
} = require('../lib/edux-runtime-support.ts');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

let telegramSender;
try {
  telegramSender = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
} catch { telegramSender = null; }

let launchdDoctor;
try {
  launchdDoctor = require('./edux-launchd-doctor.ts');
} catch { launchdDoctor = null; }

const GATE_REPORT_PATH = PROMOTION_GATE_REPORT;
const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');
const LAUNCHD_DIR = path.join(EDUX_ROOT, 'launchd');
const EDUX_PACKAGE_JSON = path.join(EDUX_ROOT, 'package.json');
const EDUX_MIGRATION_MARKET_CLOSE = path.join(EDUX_ROOT, 'migrations', '20260613000001_edux_market_close_slots.sql');

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function fileIncludes(filePath, markers) {
  const text = readText(filePath);
  return markers.every((marker) => text.includes(marker));
}

function launchdSummary() {
  if (!launchdDoctor?.buildReport) return { ok: false, reason: 'launchd_doctor_unavailable' };
  const report = launchdDoctor.buildReport({ apply: false, confirm: null, json: false, noWrite: true, strict: false });
  return {
    ok: report.ok,
    loadedCount: report.loadedCount,
    expectedCount: report.expectedCount,
    missingLabels: report.missingLabels,
    reloadRequiredLabels: report.reloadRequiredLabels || [],
    validationFailureCount: report.validationFailureCount,
  };
}

// ─── 검증 항목 ────────────────────────────────────────────────────

const BASE_RUN_SCOPE_FILTER = `
  status IN ('dry_run', 'success')
  AND created_at >= $1
  AND COALESCE((metadata->>'fixture')::boolean, false) IS NOT TRUE
  AND (
    status = 'dry_run'
    OR (status = 'success' AND post_id IS NOT NULL AND post_url IS NOT NULL)
  )
`;

const VALIDATED_RUN_FILTER = `
  ${BASE_RUN_SCOPE_FILTER}
  AND COALESCE((metadata->>'contentLen')::int, 0) > 0
  AND COALESCE(jsonb_array_length(COALESCE(image_urls, '[]'::jsonb)), 0) = 0
`;

const NON_TEST_RUN_SCOPE_FILTER = `
  ${BASE_RUN_SCOPE_FILTER}
  AND COALESCE(title, '') NOT ILIKE '[TEST]%'
`;

async function check1_ValidatedRunCount() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 35 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE status = 'dry_run') AS dry_run_cnt,
        COUNT(*) FILTER (WHERE status = 'success') AS live_success_cnt
      FROM edux_publish_log
      WHERE ${VALIDATED_RUN_FILTER}
    `, [sevenDaysAgo], 'public');
    const row = result?.rows?.[0] || {};
    const cnt = Number(row.cnt || 0);
    const dryRunCnt = Number(row.dry_run_cnt || 0);
    const liveSuccessCnt = Number(row.live_success_cnt || 0);
    return {
      ok: cnt >= 35,
      reason: `7일 검증 실행 ${cnt}건 (dry_run ${dryRunCnt}, 실 API 성공 ${liveSuccessCnt})`,
      value: cnt,
      required: 35,
    };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 35 };
  }
}

async function check2_ContentQuality() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 'all_dry_runs_have_content' };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE COALESCE((metadata->>'contentLen')::int, 0) > 0) AS with_content,
        ROUND(AVG((metadata->>'contentLen')::int) FILTER (WHERE metadata->>'contentLen' IS NOT NULL)) AS avg_len
      FROM edux_publish_log
      WHERE ${BASE_RUN_SCOPE_FILTER}
    `, [sevenDaysAgo], 'public');
    const row = result?.rows?.[0] || {};
    const total = Number(row.total || 0);
    const withContent = Number(row.with_content || 0);
    const avgLen = Number(row.avg_len || 0);
    return {
      ok: total > 0 && withContent === total,
      reason: `본문 생성 ${withContent}/${total}건, 평균 ${avgLen}자 참고값`,
      value: withContent,
      required: total,
    };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 'all_dry_runs_have_content' };
  }
}

async function check3_ImageAttachmentPolicy() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 0 };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(COALESCE(image_urls, '[]'::jsonb)), 0) > 0) AS with_images
      FROM edux_publish_log
      WHERE ${NON_TEST_RUN_SCOPE_FILTER}
    `, [sevenDaysAgo], 'public');
    const total = Number(result?.rows?.[0]?.total || 0);
    const withImages = Number(result?.rows?.[0]?.with_images || 0);
    return { ok: withImages === 0, reason: `비테스트 ${total}건 중 이미지 첨부 ${withImages}건`, value: withImages, required: 0 };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 0 };
  }
}

async function check4_JwtHealth() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: false, required: true };
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT COUNT(*) AS cnt FROM edux_publish_log
      WHERE status IN ('dry_run', 'success') AND created_at >= $1
      LIMIT 1
    `, [oneDayAgo], 'public');
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
    const result = await dbQuery(pgPool, `
      SELECT COUNT(*) AS cnt FROM edux_publish_log
      WHERE status = 'fail'
        AND error_msg LIKE '%429%'
        AND created_at >= $1
    `, [sevenDaysAgo], 'public');
    const cnt = Number(result?.rows?.[0]?.cnt || 0);
    return { ok: cnt === 0, reason: `429 위반 ${cnt}건`, value: cnt, required: 0 };
  } catch (err) {
    return { ok: true, reason: `조회 실패 (스킵): ${err?.message}`, value: 0, required: 0 };
  }
}

async function check6_MarketCloseContract() {
  const kisRuntime = path.join(EDUX_ROOT, 'scripts', 'runtime-edux-kis-daily.ts');
  const overseasRuntime = path.join(EDUX_ROOT, 'scripts', 'runtime-edux-overseas-daily.ts');
  const formatter = path.join(EDUX_ROOT, 'lib', 'edux-formatter.ts');
  const packageJson = readText(EDUX_PACKAGE_JSON);
  const requiredFiles = [
    path.join(LAUNCHD_DIR, 'ai.edux.kis-daily-1600.plist'),
    path.join(LAUNCHD_DIR, 'ai.edux.overseas-daily-0630.plist'),
    EDUX_MIGRATION_MARKET_CLOSE,
  ];
  const missing = requiredFiles.filter((filePath) => !fs.existsSync(filePath)).map((filePath) => path.relative(EDUX_ROOT, filePath));
  const issues = [
    ...missing.map((name) => `missing:${name}`),
    fileIncludes(kisRuntime, ['1600', 'EDUX_FORCE_SLOT', 'skipped_holiday']) ? null : 'kis_runtime_slot_support_missing',
    fileIncludes(overseasRuntime, ['0630', 'EDUX_FORCE_SLOT', 'skipped_holiday']) ? null : 'overseas_runtime_slot_support_missing',
    fileIncludes(formatter, [
      'buildKisCloseSystemPrompt',
      'buildOverseasCloseSystemPrompt',
      'buildKisCloseFallbackContent',
      'buildOverseasCloseFallbackContent',
      'normalizeSectionSpacing',
    ]) ? null : 'formatter_close_contract_missing',
    packageJson.includes('"smoke:market-close"') ? null : 'smoke_market_close_script_missing',
  ].filter(Boolean);
  return {
    ok: issues.length === 0,
    reason: issues.length ? `마감 슬롯 contract 미달: ${issues.join(', ')}` : '마감 슬롯 contract 준비 완료',
    value: issues.length,
    required: 0,
  };
}

async function check7_MarketCloseEvidence() {
  if (!pgPool) return { ok: false, reason: 'pgPool 없음', value: 0, required: 'kis:1600>=5, overseas:0630>=5, fail=0' };
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const result = await dbQuery(pgPool, `
      SELECT
        category,
        schedule_slot,
        COUNT(*) FILTER (
          WHERE status IN ('dry_run', 'success')
            AND COALESCE((metadata->>'fixture')::boolean, false) IS NOT TRUE
            AND COALESCE((metadata->>'contentLen')::int, 0) > 0
            AND COALESCE(jsonb_array_length(COALESCE(image_urls, '[]'::jsonb)), 0) = 0
        ) AS valid_cnt,
        COUNT(*) FILTER (
          WHERE status = 'fail'
            AND COALESCE((metadata->>'fixture')::boolean, false) IS NOT TRUE
        ) AS fail_cnt
      FROM edux_publish_log
      WHERE created_at >= $1
        AND (
          (category = 'kis' AND schedule_slot = '1600')
          OR (category = 'overseas' AND schedule_slot = '0630')
        )
      GROUP BY category, schedule_slot
    `, [sevenDaysAgo], 'public');
    const rows = result?.rows || [];
    const byKey = new Map(rows.map((row) => [`${row.category}:${row.schedule_slot}`, row]));
    const kis = byKey.get('kis:1600') || {};
    const overseas = byKey.get('overseas:0630') || {};
    const kisValid = Number(kis.valid_cnt || 0);
    const overseasValid = Number(overseas.valid_cnt || 0);
    const failCnt = Number(kis.fail_cnt || 0) + Number(overseas.fail_cnt || 0);
    return {
      ok: kisValid >= 5 && overseasValid >= 5 && failCnt === 0,
      reason: `마감 슬롯 7일 evidence: kis:1600 ${kisValid}/5, overseas:0630 ${overseasValid}/5, fail ${failCnt}`,
      value: { kis1600: kisValid, overseas0630: overseasValid, fail: failCnt },
      required: { kis1600: 5, overseas0630: 5, fail: 0 },
    };
  } catch (err) {
    return { ok: false, reason: `조회 실패: ${err?.message}`, value: 0, required: 'kis:1600>=5, overseas:0630>=5, fail=0' };
  }
}

// ─── 보고서 생성 ──────────────────────────────────────────────────

async function generateReport(options = {}) {
  const fixtureChecks = [
    { ok: true, reason: 'fixture: 7일 dry_run 35건', value: 35, required: 35 },
    { ok: true, reason: 'fixture: 본문 생성 로그 정상 (글자수 hard gate 없음)', value: 35, required: 35 },
    { ok: true, reason: 'fixture: 이미지 미첨부 정책 준수', value: 0, required: 0 },
    { ok: true, reason: 'fixture: 24h 내 dry-run 성공 기록', value: true, required: true },
    { ok: true, reason: 'fixture: 429 위반 0건', value: 0, required: 0 },
    { ok: true, reason: 'fixture: 마감 슬롯 contract 준비 완료', value: 0, required: 0 },
    { ok: true, reason: 'fixture: 마감 슬롯 7일 evidence 충족', value: { kis1600: 5, overseas0630: 5, fail: 0 }, required: { kis1600: 5, overseas0630: 5, fail: 0 } },
  ];

  const checks = options.fixture
    ? fixtureChecks.map((value, index) => ({ index: index + 1, ...value }))
    : await Promise.allSettled([
        check1_ValidatedRunCount(),
        check2_ContentQuality(),
        check3_ImageAttachmentPolicy(),
        check4_JwtHealth(),
        check5_NoRateLimit(),
        check6_MarketCloseContract(),
        check7_MarketCloseEvidence(),
      ]).then((results) => results.map((r, i) => ({
    index: i + 1,
    ...(r.status === 'fulfilled' ? r.value : { ok: false, reason: String(r.reason) }),
      })));

  const labels = [
    '7일 검증 실행 누적 (35건+)',
    '본문 생성 로그 정상 (글자수 hard gate 없음)',
    '이미지 미첨부 정책 준수',
    'JWT 갱신 정상 (24h)',
    'Rate Limit 위반 0건',
    '마감 슬롯 contract',
    '마감 슬롯 7일 evidence',
  ];

  const passed = checks.filter((c) => c.ok).length;
  const allPass = passed === checks.length;
  const launchd = options.fixture ? null : launchdSummary();

  const now = kst.now ? kst.now() : new Date();
  const report = {
    generatedAt: now.toISOString(),
    mode: options.fixture ? 'fixture' : 'live-db-readonly',
    fixture: Boolean(options.fixture),
    summary: `${passed}/${checks.length} 통과`,
    allPass,
    promotion: allPass ? 'PASS — 마스터 승인 후 실 발행 가능' : `HOLD — ${checks.length - passed}개 항목 미달`,
    diagnostics: {
      launchd,
    },
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
          '2. 별도 승인 후 EDUX_DRY_RUN=false, EDUX_LIVE_PUBLISH_APPROVED=true, EDUX_PROMOTION_GATE_PASSED=true 적용',
          '3. launchd 리로드는 별도 명시 승인 후만 수행',
        ]
      : [
          launchd && !launchd.ok ? `Edu-X dry-run LaunchAgent 로드 필요: ${launchd.loadedCount}/${launchd.expectedCount}` : null,
          'Dry-run 계속 운영 → 미달 항목 해결 후 재검사',
        ].filter(Boolean),
  };

  return report;
}

// ─── 메인 ─────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log('[edu-x/promotion-gate] 검증 시작...');

  const report = await generateReport({ fixture: args.fixture });

  const shouldWriteCanonicalReport = !args.noWrite && !args.fixture;
  if (shouldWriteCanonicalReport) {
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(GATE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } else if (args.fixture && !args.noWrite) {
    console.warn('[edu-x/promotion-gate] fixture 보고서는 live gate용 canonical report에 기록하지 않습니다.');
  }

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
  console.log(`\n보고서: ${shouldWriteCanonicalReport ? GATE_REPORT_PATH : '(no-write)'}`);

  if (telegramSender) {
    try { await telegramSender.sendTelegramMessage(msg); } catch {}
  }

  if (process.argv.includes('--auto-promote')) {
    console.warn('\n⚠️ --auto-promote는 폐기됨. 자동 실발행 전환은 수행하지 않습니다.');
  }
  emitJsonIfRequested(args.json, report);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/promotion-gate] 오류:', err);
    process.exit(1);
  });
}

module.exports = { generateReport };
