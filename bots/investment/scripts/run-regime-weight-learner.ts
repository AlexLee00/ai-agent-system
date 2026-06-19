#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/run-regime-weight-learner.ts — 체제별 가중치 학습 일일 실행
 *
 * 매일 07:00 KST
 * launchd: ai.luna.weight-adaptive-tuner-daily-0700.plist
 *
 * 실행 내용:
 *   1. 전날 거래 데이터 DB에서 분석
 *   2. 체제별 승률 + 손익비 계산
 *   3. fusion 가중치 조정 (상승/하락/횡보/변동성)
 *   4. signal 가중치 조정
 *   5. luna_regime_weight_snapshots 기록
 *   6. ta-weight-adaptive-tuner 동기화
 *   7. 텔레그램 보고
 */

import { runRegimeWeightLearner } from '../shared/regime-weight-learner.ts';
import * as db from '../shared/db.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

async function sendTelegram(message) {
  try {
    const hubUrl = process.env.HUB_URL || 'http://localhost:7788';
    const hubToken = process.env.HUB_AUTH_TOKEN;
    if (!hubToken) return;
    await fetch(`${hubUrl}/hub/notifications/telegram`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hubToken}`,
      },
      body: JSON.stringify({ message, source: 'regime-weight-learner', parseMode: 'Markdown' }),
    }).catch(() => null);
  } catch {
    // ignore
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const daysArg = process.argv.find((a) => a.startsWith('--days='))?.split('=')[1];
  const days = daysArg == null ? undefined : Number(daysArg);
  if (maybeSkipForMemory('luna.weight-adaptive-tuner')) return;

  console.log(`[RegimeWeightLearner] ${new Date().toISOString()} 학습 실행 시작 (dryRun=${dryRun}, days=${days ?? 'auto'})`);

  const adaptiveWeightEnabled = !['0', 'false', 'no', 'off', 'disabled']
    .includes(String(process.env.LUNA_ADAPTIVE_WEIGHT_ENABLED ?? 'true').toLowerCase());

  if (!dryRun && adaptiveWeightEnabled) {
    try {
      await db.initSchema().catch(() => null);
    } catch {}
  }

  const result = await runRegimeWeightLearner({
    dryRun,
    ...(days == null || !Number.isFinite(days) ? {} : { days }),
  });

  if (result.skipped) {
    console.log(`[RegimeWeightLearner] 건너뜀: ${result.reason}`);
    process.exit(0);
  }

  const today = new Date().toISOString().split('T')[0];
  let msg = `🧠 *루나 체제별 가중치 학습 — ${today}*\n\n`;
  msg += `📊 분석: 기본 ${result.days}일`;
  if (result.effectiveDays && result.effectiveDays !== result.days) {
    msg += ` · 적응형 최대 ${result.effectiveDays}일`;
  }
  msg += ` | 학습률: ${result.learnRate}\n\n`;

  for (const s of result.snapshots || []) {
    const regime = s.regime.replace('TRENDING_', '');
    const winPct = (s.winRate * 100).toFixed(1);
    const pf = s.profitFactor.toFixed(2);
    msg += `*${regime}* (거래 ${s.totalTrades}건 | 승률 ${winPct}% | PF ${pf})\n`;

    const fw = s.fusionWeights || {};
    msg += `  fusion: TA=${(fw.ta || 0).toFixed(2)} 펀더=${(fw.fundamental || 0).toFixed(2)} 감성=${(fw.sentiment || 0).toFixed(2)} WQ=${(fw.worldquant || 0).toFixed(2)}\n`;
    const diagnostic = (result.diagnostics || []).find((row) => row.regime === s.regime);
    if (diagnostic) {
      msg += `  Δ: fusion=${diagnostic.fusionDelta.toFixed(4)} signal=${diagnostic.signalDelta.toFixed(4)}\n`;
    }
    msg += '\n';
  }

  if (result.stalled?.currentRunStalled) {
    const insufficient = (result.stalled.insufficientRegimes || []).join(', ') || 'none';
    msg += `⚠️ 학습 정지 감지: insufficient=${insufficient}, allWeightsUnchanged=${result.stalled.allWeightsUnchanged ? 'true' : 'false'}\n\n`;
  }

  msg += `_데이터 → 가중치 → 수익 확률 우상향 ♻️_`;

  if (!dryRun) {
    await sendTelegram(msg);
  }

  console.log(`[RegimeWeightLearner] 완료 (체제 ${result.regimesUpdated}개 업데이트)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[RegimeWeightLearner] 오류:`, err);
  process.exit(1);
});
