#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLunaPaperPromotionGateReport,
  evaluateLunaPaperPromotionHistory,
} from '../shared/luna-paper-promotion-gate.ts';
import { runLunaPaperPromotionGateShadow } from './runtime-luna-paper-promotion-gate.ts';

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const passEvidence = {
  bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
  weightVector: { noLookaheadOk: true },
};
const hardHoldEvidence = {
  bottleneckAvoidance: { present: true, hardHold: true, preventedOrder: false, action: 'quarantine_candidate_shadow' },
  weightVector: { noLookaheadOk: true },
};

const passHistory = [
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.74, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(1) },
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(31) },
  { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: passEvidence, observed_at: iso(61) },
];
const pass = evaluateLunaPaperPromotionHistory(passHistory, {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(pass.promotionCandidate, true);
assert.equal(pass.decision, 'shadow_promotion_candidate_ready');
assert.equal(pass.consecutivePasses, 3);
assert.equal(pass.evidence.promotionRequiresExplicitMasterApproval, true);
assert.equal(pass.liveMutation, false);

const blocked = evaluateLunaPaperPromotionHistory([
  { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.55, status: 'no_action', shadow_only: true, evidence: hardHoldEvidence, observed_at: iso(1) },
  ...passHistory.slice(1).map((row) => ({ ...row, symbol: 'RISK/USDT' })),
], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(blocked.promotionCandidate, false);
assert.equal(blocked.decision, 'shadow_promotion_observe');
assert.ok(blocked.blockReasons.includes('candidate_bottleneck_hard_hold_seen'));
assert.equal(blocked.consecutivePasses, 0);

const report = buildLunaPaperPromotionGateReport([...passHistory, ...passHistory.map((row) => ({ ...row, symbol: 'LOW/USDT', confidence: 0.4 }))], {
  minCycles: 3,
  minConsecutivePasses: 3,
  minAvgConfidence: 0.62,
  maxOrderUsdt: 50,
});
assert.equal(report.promotionReady, false);
assert.equal(report.requiredApproval, 'explicit_master_live_promotion_approval');
assert.equal(report.summary.promotionCandidates, 1);

const inserted = [];
const runtime = await runLunaPaperPromotionGateShadow({
  json: true,
  fixture: true,
  dryRun: true,
  apply: false,
}, {
  insertGate: async (row) => inserted.push(row),
});
assert.equal(runtime.ok, true);
assert.equal(runtime.writeMode, 'plan-only');
assert.equal(runtime.summary.promotionCandidates, 1);
assert.equal(inserted.length, 0);

await assert.rejects(
  () => runLunaPaperPromotionGateShadow({
    json: true,
    fixture: true,
    dryRun: true,
    apply: true,
    confirm: 'luna-paper-promotion-gate-shadow',
  }, {
    ensureSchema: async () => null,
    insertGate: async (row) => inserted.push(row),
  }),
  /cannot combine --apply with --dry-run/,
);
assert.equal(inserted.length, 0);

const applied = [];
const applyRuntime = await runLunaPaperPromotionGateShadow({
  json: true,
  fixture: true,
  apply: true,
  confirm: 'luna-paper-promotion-gate-shadow',
}, {
  ensureSchema: async () => null,
  insertGate: async (row) => applied.push(row),
});
assert.equal(applyRuntime.writeMode, 'promotion-gate-shadow-apply');
assert.equal(applied.length, applyRuntime.items.length);
assert.equal(applyRuntime.promotionReady, false);

const root = path.resolve(import.meta.dirname, '..');
const bootstrap = fs.readFileSync(path.join(root, 'shared/db/schema/tables/bootstrap.ts'), 'utf8');
assert.match(bootstrap, /luna_paper_promotion_gate_shadow/);

const payload = {
  ok: true,
  smoke: 'luna-paper-promotion-gate',
  pass: {
    decision: pass.decision,
    consecutivePasses: pass.consecutivePasses,
    promotionCandidate: pass.promotionCandidate,
  },
  blocked: {
    decision: blocked.decision,
    reasons: blocked.blockReasons,
  },
  runtime: {
    writeMode: runtime.writeMode,
    promotionCandidates: runtime.summary.promotionCandidates,
    applyDryRunRejected: true,
    applyRows: applied.length,
    liveMutation: runtime.liveMutation,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-paper-promotion-gate-smoke ok');
}
