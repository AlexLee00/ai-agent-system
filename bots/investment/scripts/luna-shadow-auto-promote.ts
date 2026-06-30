#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/luna-shadow-auto-promote.ts — 하이브리드 승급 게이트 검증 알림
 *
 * 체크:
 *   - runtime-luna-hybrid-promotion-gate (Phase 1~10) 호출 (read-only)
 *   - status === 'luna_hybrid_promotion_gate_ready_for_master_review'
 *   - manualPromotionReviewCandidate === true
 *
 * 조건 충족 시: Telegram general 채널에 마스터 검토 요청 메시지 전송
 * 자동 LIVE flip 하지 않음 — gate는 read-only, 마스터 최종 결정 필수
 *
 * 실행:
 *   node scripts/luna-shadow-auto-promote.ts
 *   node scripts/luna-shadow-auto-promote.ts --dry-run
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { closeAll } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender   = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));
const { today }        = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst'));

import { runLunaHybridPromotionGate } from './runtime-luna-hybrid-promotion-gate.ts';

const DRY_RUN = process.argv.includes('--dry-run');

const EVIDENCE_HOURS = 168; // hybrid-gate 증거 lookback (7일)
const READY_STATUS   = 'luna_hybrid_promotion_gate_ready_for_master_review';

async function closePools() {
  if (typeof closeAll === 'function') await closeAll().catch(() => {});
}

// ─── Hybrid Gate 집계 ─────────────────────────────────────────────

async function fetchHybridGateReport() {
  try {
    const report = await runLunaHybridPromotionGate({
      apply: false, json: true, strict: false, noDb: false, hours: EVIDENCE_HOURS,
    });
    return report as any;
  } catch (e) {
    console.error('[shadow-auto-promote] hybrid-gate 호출 실패:', e?.message ?? e);
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`[luna-shadow-auto-promote] 시작 (dry-run=${DRY_RUN})`);
  console.log(`  조건: status=${READY_STATUS} & manualPromotionReviewCandidate=true (증거 ${EVIDENCE_HOURS}h)`);

  const report = await fetchHybridGateReport();
  const status = report?.status ?? 'unknown';
  const s = report?.summary ?? {};
  const reviewReady = report?.manualPromotionReviewCandidate === true && status === READY_STATUS;
  console.log(`  실제: status=${status}, reviewCandidate=${report?.manualPromotionReviewCandidate === true}, contractFailures=${s.contractFailures}, securityFailures=${s.securityFailures}, evidenceWarnings=${s.evidenceWarnings}`);

  if (!reviewReady) {
    console.log('[shadow-auto-promote] 조건 미충족 — 대기 중');
    await closePools();
    return;
  }

  const message = `🚀 [루나] 하이브리드 승급 게이트 — 마스터 검토 요청

Phase 1~10 Shadow 검증 통과:
  계약 실패: ${s.contractFailures ?? '?'} / ${s.contractChecks ?? '?'} (0 기대 ✅)
  보안 실패: ${s.securityFailures ?? '?'} / ${s.securityChecks ?? '?'} (0 기대 ✅)
  증거 경고: ${s.evidenceWarnings ?? '?'} (0 기대 ✅)
  상태:      ${status}
  기준일:    ${today()}

▶ 마스터 상세 리뷰:
  cd bots/investment && node scripts/runtime-luna-hybrid-promotion-review.ts --json --strict

⚠️ 자동 LIVE 전환 없음 — gate는 read-only, 마스터 승인 runbook 필요`;

  console.log(`\n${message}`);

  if (!DRY_RUN) {
    try {
      await telegramSender.send('general', message);
      console.log('[shadow-auto-promote] general 채널 전송 완료');
    } catch (e) {
      console.error('[shadow-auto-promote] 전송 실패:', e?.message ?? e);
    }
  }

  console.log('[shadow-auto-promote] 완료');
  await closePools();
}

main().catch((e) => {
  console.error('[luna-shadow-auto-promote] 오류:', e);
  process.exit(1);
});
