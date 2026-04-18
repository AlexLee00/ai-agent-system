#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/crypto-live-gate-review.js
 *
 * 목적:
 *   - 최근 암호화폐 자동매매 퍼널/차단/운영모드 상태를 한 번에 요약
 *   - PAPER -> LIVE 전환 판단을 관측 사실과 분리해 제안
 *
 * 실행:
 *   node bots/investment/scripts/crypto-live-gate-review.js
 *   node bots/investment/scripts/crypto-live-gate-review.js --days=7
 *   node bots/investment/scripts/crypto-live-gate-review.js --json
 */

import * as db from '../shared/db.ts';
import { pathToFileURL } from 'url';

export const DEFAULT_CRYPTO_LIVE_GATE_DAYS = 7;

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || DEFAULT_CRYPTO_LIVE_GATE_DAYS)),
    json: argv.includes('--json'),
  };
}

function toCount(rows, predicate) {
  return rows.filter(predicate).reduce((sum, row) => sum + Number(row.cnt || 0), 0);
}

async function loadPipelineRows(days) {
  return db.query(`
    SELECT
      market,
      COALESCE(JSONB_AGG(meta) FILTER (WHERE meta IS NOT NULL), '[]'::jsonb) AS meta_rows
    FROM pipeline_runs
    WHERE pipeline = 'luna_pipeline'
      AND CAST(to_timestamp(started_at / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE)
          >= CURRENT_DATE - ($1::int - 1)
    GROUP BY market
  `, [days]).catch(() => []);
}

async function loadTradeRows(days) {
  return db.query(`
    SELECT
      COALESCE(trade_mode, 'normal') AS trade_mode,
      paper,
      COUNT(*) AS cnt
    FROM trades
    WHERE exchange = 'binance'
      AND CAST(executed_at AS DATE) >= CURRENT_DATE - ($1::int - 1)
    GROUP BY 1, 2
    ORDER BY 1, 2
  `, [days]).catch(() => []);
}

async function loadBlockRows(days) {
  return db.query(`
    SELECT
      COALESCE(NULLIF(block_code, ''), 'legacy_unclassified') AS block_code,
      COUNT(*) AS cnt
    FROM signals
    WHERE exchange = 'binance'
      AND CAST(created_at AT TIME ZONE 'Asia/Seoul' AS DATE) >= CURRENT_DATE - ($1::int - 1)
      AND status IN ('failed', 'rejected', 'expired')
    GROUP BY 1
    ORDER BY cnt DESC, block_code ASC
  `, [days]).catch(() => []);
}

async function loadClosedReviewRows(days) {
  return db.query(`
    SELECT
      COUNT(*) AS cnt
    FROM trade_journal
    WHERE exchange = 'binance'
      AND status IN ('closed', 'tp_hit', 'sl_hit', 'force_exit')
      AND exit_time IS NOT NULL
      AND CAST(to_timestamp(exit_time / 1000.0) AT TIME ZONE 'Asia/Seoul' AS DATE)
          >= CURRENT_DATE - ($1::int - 1)
  `, [days]).catch(() => []);
}

function aggregatePipeline(pipelineRows) {
  const summary = {
    decision: 0,
    buy: 0,
    sell: 0,
    hold: 0,
    approved: 0,
    executed: 0,
    weak: 0,
    risk: 0,
    modeCounts: {},
    weakReasons: {},
    riskRejectReasons: {},
  };

  for (const row of pipelineRows) {
    const market = String(row.market || '').toLowerCase();
    if (!['crypto', 'binance'].includes(market)) continue;
    for (const meta of (row.meta_rows || [])) {
      summary.decision += Number(meta?.decided_symbols || 0);
      summary.buy += Number(meta?.buy_decisions || 0);
      summary.sell += Number(meta?.sell_decisions || 0);
      summary.hold += Number(meta?.hold_decisions || 0);
      summary.approved += Number(meta?.approved_signals || 0);
      summary.executed += Number(meta?.executed_symbols || 0);
      summary.weak += Number(meta?.weak_signal_skipped || 0);
      summary.risk += Number(meta?.risk_rejected || 0);
      const mode = String(meta?.investment_trade_mode || 'normal').toUpperCase();
      summary.modeCounts[mode] = (summary.modeCounts[mode] || 0) + 1;
      for (const [reason, count] of Object.entries(meta?.weak_signal_reasons || {})) {
        summary.weakReasons[reason] = (summary.weakReasons[reason] || 0) + Number(count || 0);
      }
      for (const [reason, count] of Object.entries(meta?.risk_reject_reasons || {})) {
        const text = String(reason || '');
        let key = text;
        if (text.includes('최대 포지션')) key = 'max_positions';
        else if (text.includes('동일 LIVE 포지션')) key = 'validation_live_overlap';
        summary.riskRejectReasons[key] = (summary.riskRejectReasons[key] || 0) + Number(count || 0);
      }
    }
  }

  summary.weakTop = Object.entries(summary.weakReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return summary;
}

function aggregateTrades(tradeRows) {
  const summary = {
    total: 0,
    live: 0,
    paper: 0,
    byMode: {},
  };

  for (const row of tradeRows) {
    const mode = String(row.trade_mode || 'normal').toUpperCase();
    const count = Number(row.cnt || 0);
    const bucket = summary.byMode[mode] || { total: 0, live: 0, paper: 0 };
    bucket.total += count;
    summary.total += count;
    if (row.paper) {
      bucket.paper += count;
      summary.paper += count;
    } else {
      bucket.live += count;
      summary.live += count;
    }
    summary.byMode[mode] = bucket;
  }

  return summary;
}

function getTradeModeCounts(trades, mode) {
  const bucket = trades.byMode[String(mode || 'normal').toUpperCase()] || { total: 0, live: 0, paper: 0 };
  return {
    total: Number(bucket.total || 0),
    live: Number(bucket.live || 0),
    paper: Number(bucket.paper || 0),
  };
}

function aggregateBlocks(blockRows) {
  const mapped = {};
  for (const row of blockRows) {
    mapped[String(row.block_code || 'legacy_unclassified')] = Number(row.cnt || 0);
  }
  return {
    raw: mapped,
    top: Object.entries(mapped).sort((a, b) => b[1] - a[1])[0] || null,
    paperReentry: mapped.paper_position_reentry_blocked || 0,
    liveReentry: mapped.live_position_reentry_blocked || 0,
    sameDayReentry: mapped.same_day_reentry_blocked || 0,
  };
}

function buildReview({ days, pipeline, trades, blocks, closedReviews }) {
  const facts = [];
  const inferred = [];
  const recommendations = [];
  const validationTrades = getTradeModeCounts(trades, 'validation');
  const normalTrades = getTradeModeCounts(trades, 'normal');
  const paperValidationSamples = Number(validationTrades.paper || 0);
  const hasPaperValidation = paperValidationSamples > 0;
  const sufficientPaperValidation = paperValidationSamples >= 3;

  facts.push(`최근 ${days}일 암호화폐 decision ${pipeline.decision}건, BUY ${pipeline.buy}건, approved ${pipeline.approved}건, executed ${pipeline.executed}건`);
  facts.push(`최근 ${days}일 암호화폐 체결 ${trades.total}건 (LIVE ${trades.live} / PAPER ${trades.paper})`);
  facts.push(`trade_mode별 체결: NORMAL ${normalTrades.total}건 (LIVE ${normalTrades.live} / PAPER ${normalTrades.paper}), VALIDATION ${validationTrades.total}건 (LIVE ${validationTrades.live} / PAPER ${validationTrades.paper})`);
  facts.push(`weakSignalSkipped ${pipeline.weak}건${pipeline.weakTop ? `, 최다 사유 ${pipeline.weakTop}` : ''}`);
  facts.push(`재진입 차단: PAPER ${blocks.paperReentry}건 / LIVE ${blocks.liveReentry}건 / same-day ${blocks.sameDayReentry}건`);
  facts.push(`최근 ${days}일 종료된 암호화폐 거래 리뷰 ${closedReviews}건`);

  if (pipeline.weakTop === 'confidence_near_threshold') {
    inferred.push('신호 품질이 완전히 낮다기보다 confidence 임계값 바로 아래에서 많이 잘리고 있을 가능성이 큼');
    recommendations.push('crypto confidence threshold는 즉시 크게 내리지 말고, near-threshold 비율이 1~2일 더 유지되는지 먼저 관찰');
  } else if (pipeline.weakTop === 'confidence_far_below_threshold') {
    inferred.push('threshold 문제보다 신호 품질 자체가 낮을 가능성이 큼');
    recommendations.push('threshold 완화보다 analyst calibration과 onchain BUY 편향 보정이 우선');
  } else if (pipeline.weakTop === 'confidence_mid_gap') {
    inferred.push('신호 품질과 threshold 문제가 중간 지점에서 같이 작용할 가능성이 큼');
    recommendations.push('threshold 미세조정은 가능하지만, weak reason 분포가 더 누적된 뒤 소폭 실험하는 것이 안전');
  } else {
    inferred.push('새 weak reason 계측이 아직 충분히 누적되지 않았거나 최근 약한 신호 스킵이 크지 않음');
    recommendations.push('다음 1~2회 파이프라인 실행 후 weakTop 분포를 재확인');
  }

  if (blocks.paperReentry > 0 && blocks.liveReentry === 0) {
    inferred.push('현재 추가진입 병목은 실거래보다 검증용 PAPER 포지션 과밀에 더 가깝다');
    recommendations.push('validation/NORMAL PAPER의 scale-in 완화 여부를 별도 검토하되 LIVE reentry 정책은 그대로 유지');
  } else if (blocks.liveReentry > 0) {
    inferred.push('실제 LIVE 포지션 보유 상태가 추가진입 병목으로 작동하고 있다');
    recommendations.push('LIVE 전환 전에는 live reentry 완화보다 exposure/risk policy를 먼저 재검토');
  } else {
    inferred.push('현재 재진입 차단이 주요 병목으로 두드러지지는 않는다');
  }

  if (validationTrades.live > 0 && validationTrades.paper === 0) {
    inferred.push('현재 암호화폐 validation은 PAPER 검증이 아니라 LIVE 소액 검증 레일로 운영되고 있다');
    recommendations.push('LIVE gate 문구와 health 리포트에서 validation LIVE와 PAPER 부족을 분리해 해석해야 한다');
  } else if (validationTrades.paper > 0) {
    inferred.push(`암호화폐 validation 레일에 PAPER 검증 표본이 일부 존재한다 (${paperValidationSamples}건)`);
    if (!sufficientPaperValidation) {
      recommendations.push(`PAPER validation 표본을 최소 3건까지 더 확보해 표본 해석을 안정화하는 편이 좋다 (현재 ${paperValidationSamples}건)`);
    }
  }

  const maxPositionRejects = Number(pipeline.riskRejectReasons.max_positions || 0);
  const validationLiveOverlap = Number(pipeline.riskRejectReasons.validation_live_overlap || 0);
  if (maxPositionRejects > 0) {
    inferred.push(`최근 실행 병목에는 포지션 한도 초과가 포함되어 있다 (max positions ${maxPositionRejects}건)`);
  }
  if (validationLiveOverlap > 0) {
    inferred.push(`validation 레일은 LIVE 포지션 중복 차단도 받고 있다 (${validationLiveOverlap}건)`);
  }

  let liveDecision = 'blocked';
  let liveReason = hasPaperValidation
    ? `PAPER validation 표본은 ${paperValidationSamples}건 확보됐지만 아직 얇고, weak 신호 분포를 더 관찰해야 한다`
    : 'validation LIVE 표본은 있으나 PAPER 검증 표본이 아직 없다';
  if (maxPositionRejects > 0 || validationLiveOverlap > 0) {
    if (hasPaperValidation) {
      liveReason = `PAPER validation 표본 ${paperValidationSamples}건은 확보됐고, 현재 직접 병목은 max positions ${maxPositionRejects}건 / validation LIVE overlap ${validationLiveOverlap}건이다`;
    } else {
      liveReason = `PAPER 검증 표본이 아직 없고, 최근 실행 병목은 max positions ${maxPositionRejects}건 / validation LIVE overlap ${validationLiveOverlap}건이다`;
    }
  }
  if (
    trades.live > 0 &&
    sufficientPaperValidation &&
    closedReviews >= 3 &&
    blocks.liveReentry === 0 &&
    pipeline.weak <= Math.max(5, pipeline.executed)
  ) {
    liveDecision = 'candidate';
    liveReason = '제한형 LIVE 검토 후보 조건에 일부 접근';
  }

  if (trades.live === 0) {
    recommendations.push('현재 암호화폐는 PAPER-only이므로 즉시 LIVE 전환은 금지하고 최소 1~2일 추가 관찰 유지');
  }
  if (closedReviews === 0) {
    recommendations.push('청산 품질 데이터가 없으므로 executed 수보다 closed review 확보를 우선');
  }

  return {
    periodDays: days,
    facts,
    inferred,
    recommendations,
    liveGate: {
      decision: liveDecision,
      reason: liveReason,
    },
    metrics: {
      pipeline,
      trades,
      blocks,
      closedReviews,
    },
  };
}

function printHuman(review) {
  const lines = [];
  lines.push(`🧭 암호화폐 LIVE 전환 게이트 리뷰 (${review.periodDays}일)`);
  lines.push('');
  lines.push('관측 사실:');
  for (const line of review.facts) lines.push(`- ${line}`);
  lines.push('');
  lines.push('추론 원인:');
  for (const line of review.inferred) lines.push(`- ${line}`);
  lines.push('');
  lines.push('권장 조정:');
  for (const line of review.recommendations) lines.push(`- ${line}`);
  lines.push('');
  lines.push(`LIVE 게이트: ${review.liveGate.decision}`);
  lines.push(`사유: ${review.liveGate.reason}`);
  return lines.join('\n');
}

export async function loadCryptoLiveGateReview(days = DEFAULT_CRYPTO_LIVE_GATE_DAYS) {
  await db.initSchema();

  const [pipelineRows, tradeRows, blockRows, closedReviewRows] = await Promise.all([
    loadPipelineRows(days),
    loadTradeRows(days),
    loadBlockRows(days),
    loadClosedReviewRows(days),
  ]);

  const review = buildReview({
    days,
    pipeline: aggregatePipeline(pipelineRows),
    trades: aggregateTrades(tradeRows),
    blocks: aggregateBlocks(blockRows),
    closedReviews: Number(closedReviewRows?.[0]?.cnt || 0),
  });

  return review;
}

async function main() {
  const { days, json } = parseArgs();
  const review = await loadCryptoLiveGateReview(days);

  if (json) {
    process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${printHuman(review)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
    process.exit(1);
  });
}
