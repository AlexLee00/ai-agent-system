// @ts-nocheck

import * as db from './db.ts';
import { evaluateTossOrderPreflightHook } from './brokers/toss-order-preflight-hook.ts';
import { getTossPromotionStage, isTossPaperMirrorStage } from './brokers/promotion-stage.ts';
import { buildTossBalanceShadowComparison } from './luna-toss-balance-shadow.ts';

export const LUNA_TOSS_PAPER_MIRROR_CONFIRM = 'luna-toss-paper-mirror-shadow';

function normalizeMarket(value = 'domestic') {
  const raw = String(value || '').trim().toLowerCase();
  if (['overseas', 'us', 'usa', 'kis_overseas'].includes(raw)) return 'overseas';
  if (['domestic', 'kr', 'korea', 'kis', 'kis_domestic'].includes(raw)) return 'domestic';
  return 'domestic';
}

function toCandidate(row = {}) {
  return {
    preflightLogId: row.id,
    strategySignalId: row.strategy_signal_id || row.strategySignalId || null,
    market: normalizeMarket(row.market),
    symbol: String(row.symbol || '').trim().toUpperCase(),
    family: row.family || null,
    side: 'buy',
    quantity: row.quantity || row.qty || null,
    rr: row.rr == null ? null : Number(row.rr),
    sourceDecision: row.decision || null,
    evidence: {
      gates: row.gates || [],
      regime: row.regime || {},
      evaluatedAt: row.evaluated_at || row.evaluatedAt || null,
    },
  };
}

export async function loadPaperMirrorCandidates(options = {}, deps = {}) {
  if (Array.isArray(options.candidates)) return options.candidates.map(toCandidate);
  const market = normalizeMarket(options.market || 'domestic');
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  const queryFn = deps.queryFn || options.queryFn || db.query;
  const rows = await queryFn(
    `SELECT id, strategy_signal_id, market, symbol, family, decision, gates, regime, rr, evaluated_at
       FROM investment.luna_entry_preflight_log
      WHERE market = $1
        AND decision IN ('pass', 'pass_with_skips')
        AND evaluated_at >= NOW() - INTERVAL '7 days'
      ORDER BY evaluated_at DESC
      LIMIT $2`,
    [market, limit],
  ).catch(() => []);
  return (Array.isArray(rows) ? rows : []).map(toCandidate);
}

export async function insertTossPaperMirrorLog(row = {}, runFn = db.run) {
  return runFn(
    `INSERT INTO investment.luna_toss_paper_mirror_log
       (preflight_log_id, strategy_signal_id, market, symbol, side, quantity, would_place, placed, stage, toss_verify, balance_shadow, evidence, observed_at, shadow_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, COALESCE($13::timestamptz, NOW()), TRUE)
     RETURNING id`,
    [
      row.preflightLogId || null,
      row.strategySignalId || null,
      row.market,
      row.symbol,
      row.side || 'buy',
      row.quantity == null ? null : Number(row.quantity),
      row.wouldPlace === true,
      false,
      row.stage || 's1_paper_mirror',
      JSON.stringify(row.tossVerify || {}),
      JSON.stringify(row.balanceShadow || {}),
      JSON.stringify(row.evidence || {}),
      row.observedAt || null,
    ],
  );
}

export async function runTossPaperMirror(options = {}, deps = {}) {
  const dryRun = options.dryRun !== false && options.apply !== true;
  const apply = options.apply === true;
  if (apply && options.confirm !== LUNA_TOSS_PAPER_MIRROR_CONFIRM) {
    throw new Error(`runTossPaperMirror apply requires confirm=${LUNA_TOSS_PAPER_MIRROR_CONFIRM}`);
  }
  const stage = (deps.getTossPromotionStage || getTossPromotionStage)(options.stageOptions || { stage: options.stage }, deps);
  if (apply && !isTossPaperMirrorStage(stage) && options.force !== true) {
    throw new Error(`runTossPaperMirror apply requires stage=s1_paper_mirror; current=${stage.stage}`);
  }
  const candidates = await (deps.loadCandidates || loadPaperMirrorCandidates)(options, deps);
  const rows = [];
  const shouldMirror = isTossPaperMirrorStage(stage) || options.force === true || dryRun;
  for (const candidate of candidates) {
    const tossVerify = shouldMirror
      ? await (deps.evaluateHook || evaluateTossOrderPreflightHook)(candidate, { ...options, stageOptions: { stage: 's1_paper_mirror' } }, deps)
      : { ok: false, reason: 'stage_not_s1_paper_mirror', stage };
    const balanceShadow = await (deps.buildBalanceShadow || buildTossBalanceShadowComparison)({
      market: candidate.market,
      symbol: candidate.symbol,
      queryFn: deps.queryFn || options.queryFn,
    }, deps).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      shadowOnly: true,
    }));
    const row = {
      ...candidate,
      wouldPlace: true,
      placed: false,
      stage: stage.stage,
      tossVerify,
      balanceShadow,
      evidence: {
        source: 'luna_toss_paper_mirror',
        sourceDecision: candidate.sourceDecision,
        candidateEvidence: candidate.evidence,
        liveMutation: false,
      },
    };
    if (apply && !dryRun) {
      const inserted = await (deps.insertLog || insertTossPaperMirrorLog)(row, deps.runFn || db.run);
      row.insertedId = Array.isArray(inserted) ? inserted[0]?.id || null : inserted?.id || null;
    }
    rows.push(row);
  }
  return {
    ok: true,
    stage: stage.stage,
    stageState: stage,
    evaluated: rows.length,
    written: apply && !dryRun ? rows.length : 0,
    placed: 0,
    liveMutation: false,
    dryRun,
    rows,
  };
}

export default {
  LUNA_TOSS_PAPER_MIRROR_CONFIRM,
  loadPaperMirrorCandidates,
  insertTossPaperMirrorLog,
  runTossPaperMirror,
};
