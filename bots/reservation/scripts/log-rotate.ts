'use strict';

/**
 * scripts/log-rotate.js — launchd 서비스 로그 로테이션
 *
 * 방식: copy + truncate (copytruncate)
 *   - 원본 파일을 날짜 suffix 아카이브로 복사 후 원본 0바이트로 truncate
 *   - launchd가 O_APPEND로 파일을 열고 있으므로 truncate 후 새 내용은 처음부터 기록됨
 *   - 실행 중인 프로세스 재시작 불필요
 *
 * 대상:
 *   - /tmp/naver-ops-mode.log (가장 빠르게 성장)
 *   - /tmp/pickko-*.log (kiosk-monitor, verify, daily-audit, daily-summary)
 *   - /tmp/ska-*.log (health-check, db-backup)
 *   - AI Agent reservation runtime/log-report-*.log
 *   - legacy OpenClaw 날짜별 로그 (migration window 동안 오래된 파일 삭제만)
 *
 * 보관: 7일 (KEEP_DAYS)
 * 최소 크기: 1KB 이상일 때만 로테이션
 * 실행: launchd ai.ska.log-rotate (매일 04:05)
 */

const fs   = require('fs');
const path = require('path');
const { buildReservationCliInsight } = require('../lib/cli-insight');
const { getReservationRuntimeDir } = require('../lib/runtime-paths');

const WORKSPACE = getReservationRuntimeDir();
const KEEP_DAYS = 7;
const MIN_BYTES = 1024; // 1KB 미만 스킵

// ── 날짜 ─────────────────────────────────────────────────────────────────

function todayStr() {
  // YYYY-MM-DD (로컬 시간)
  return new Date().toLocaleDateString('en-CA');
}

// ── copytruncate 로테이션 대상 ────────────────────────────────────────────

const ROTATE_FILES = [
  '/tmp/naver-ops-mode.log',
  '/tmp/pickko-kiosk-monitor.log',
  '/tmp/pickko-verify.log',
  '/tmp/pickko-daily-audit.log',
  '/tmp/pickko-daily-summary.log',
  '/tmp/pickko-verify-launchd.log',
  '/tmp/ska-db-backup.log',
  '/tmp/ska-health-check.log',
  path.join(WORKSPACE, 'log-report-out.log'),
  path.join(WORKSPACE, 'log-report-err.log'),
];

// ── 로테이션 함수 ─────────────────────────────────────────────────────────

function rotateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { status: 'skip', reason: 'not found' };
  }

  const stat = fs.statSync(filePath);
  if (stat.size < MIN_BYTES) {
    return { status: 'skip', reason: `${stat.size}B < 1KB` };
  }

  const date    = todayStr();
  const ext     = path.extname(filePath);
  const base    = filePath.slice(0, -ext.length);
  const archive = `${base}-${date}${ext}`;

  if (fs.existsSync(archive)) {
    return { status: 'skip', reason: '오늘 이미 로테이션됨' };
  }

  // copy → truncate
  fs.copyFileSync(filePath, archive);
  fs.truncateSync(filePath, 0);

  return { status: 'rotated', archive, size: stat.size };
}

// ── 오래된 아카이브 삭제 ──────────────────────────────────────────────────

function purgeOldArchives(filePath) {
  const dir  = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const ext  = path.extname(filePath);

  if (!fs.existsSync(dir)) return;

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

  fs.readdirSync(dir)
    .filter(f => f.startsWith(`${base}-`) && f.endsWith(ext) && f !== path.basename(filePath))
    .forEach(f => {
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          console.log(`[로그 정리] 삭제: ${f}`);
        }
      } catch { /* 삭제 실패 무시 */ }
    });
}

// ── OpenClaw 날짜별 로그 정리 ─────────────────────────────────────────────

function purgeOpenclawLogs() {
  const dir = '/tmp/openclaw';
  if (!fs.existsSync(dir)) return;

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

  fs.readdirSync(dir)
    .filter(f => f.startsWith('openclaw-') && f.endsWith('.log'))
    .forEach(f => {
      const full = path.join(dir, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          console.log(`[로그 정리] OpenClaw 삭제: ${f}`);
        }
      } catch { /* 삭제 실패 무시 */ }
    });
}

// ── 메인 ─────────────────────────────────────────────────────────────────

function main() {
  console.log(`[로그 로테이션] 시작 — ${new Date().toISOString()}`);

  let rotated = 0;
  let skipped = 0;

  for (const filePath of ROTATE_FILES) {
    const r = rotateFile(filePath);
    const name = path.basename(filePath);

    if (r.status === 'rotated') {
      const kb = (r.size / 1024).toFixed(1);
      console.log(`[로그 로테이션] ✅ ${name} → ${path.basename(r.archive)} (${kb}KB)`);
      purgeOldArchives(filePath);
      rotated++;
    } else {
      console.log(`[로그 로테이션] ⏭️  ${name}: ${r.reason}`);
      skipped++;
    }
  }

  purgeOpenclawLogs();

  console.log(`[로그 로테이션] 완료 — 로테이션 ${rotated}개, 스킵 ${skipped}개`);
  buildReservationCliInsight({
    bot: 'reservation-log-rotate',
    requestType: 'reservation-log-rotate',
    title: '예약 로그 로테이션 요약',
    data: {
      rotated,
      skipped,
      targets: ROTATE_FILES.length,
    },
    fallback:
      rotated > 0
        ? `예약 로그 로테이션은 ${rotated}개 파일을 정리했고 ${skipped}개는 그대로 유지했습니다.`
        : `예약 로그 로테이션은 모두 스킵되어 현재는 로그 크기 변화만 더 보면 됩니다.`,
  }).then((aiSummary) => {
    if (aiSummary) console.log(`🔍 AI: ${aiSummary}`);
  }).catch(() => {});
}

main();
