#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import * as db from '../shared/db.ts';
import { computeJaenongPullbackScore } from '../shared/market-regime.ts';
import {
  buildJaenongPriorityRoute,
  getJaenongBriefStatus,
  recordJaenongRouteShadow,
} from '../shared/jaenong-operations.ts';
import { buildOverseasPullbackUniverse } from '../team/argos.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const JAENONG_ROUTE_WRITE_CONFIRM = 'jaenong-route-shadow';

function fixtureInputs(now) {
  return {
    reference: {
      snapshotHash: 'f'.repeat(64),
      timing: { values: { spyDrawdownRatio: -0.1, vix: 20, fearGreed: 30 } },
      interest: [
        { symbol: 'MSFT', currentPrice: 400, marketCapBillionUsd: 3_000, drawdownRatio: -0.2, drawdownZone: 'pullback' },
      ],
    },
    topVolumeCandidates: [{ symbol: 'NVDA', quoteVolume: 1000, rank: 1 }],
    briefStatusOptions: { fixture: true, now },
  };
}

async function loadInputs(options, deps) {
  if (options.fixture === true) return fixtureInputs(options.now || new Date());
  const queryFn = deps.queryFn || db.query;
  const referenceRows = await queryFn(
    `SELECT snapshot_hash, timing, interest
       FROM investment.jaenong_reference_snapshot
      WHERE parse_status IN ('parsed', 'partial')
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [],
  );
  const screeningRows = await queryFn(
    `SELECT screening_data->'overseas'->'screening' AS top_volume_candidates
       FROM screening_history
      WHERE market = 'all'
      ORDER BY date DESC
      LIMIT 1`,
    [],
  ).catch(() => []);
  const row = referenceRows?.[0] || null;
  return {
    reference: row ? {
      snapshotHash: row.snapshot_hash,
      timing: row.timing || {},
      interest: row.interest || [],
    } : null,
    topVolumeCandidates: screeningRows?.[0]?.top_volume_candidates || [],
    briefStatusOptions: { now: options.now },
    queryFn,
  };
}

function pullbackCandidates(reference) {
  return buildOverseasPullbackUniverse((reference?.interest || []).map((row) => {
    const currentPrice = Number(row.currentPrice || 0);
    const drawdownRatio = Number(row.drawdownRatio);
    return {
      symbol: row.symbol,
      currentPrice,
      high52Week: currentPrice > 0 && Number.isFinite(drawdownRatio) && drawdownRatio > -1
        ? currentPrice / (1 + drawdownRatio)
        : 0,
      marketCapUsd: Number(row.marketCapBillionUsd || 0) * 1_000_000_000,
    };
  }), { maxSymbols: 20 });
}

function pullbackScore(reference) {
  const timing = reference?.timing?.values || {};
  const ratio = Number(timing.spyDrawdownRatio);
  return computeJaenongPullbackScore({
    spyDrawdownPct: Number.isFinite(ratio) ? ratio * 100 : null,
    vix: timing.vix,
    fearGreed: timing.fearGreed,
  });
}

function signalRef(input) {
  return `j3:${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 24)}`;
}

export async function runJaenongRouteShadow(options = {}, deps = {}) {
  if (options.write === true && options.confirm !== JAENONG_ROUTE_WRITE_CONFIRM) {
    throw new Error('jaenong_route_write_confirmation_required');
  }
  const now = new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw new Error('jaenong_route_now_invalid');
  const inputs = await loadInputs(options, deps);
  const briefStatus = await getJaenongBriefStatus(inputs.briefStatusOptions, {
    queryFn: inputs.queryFn || deps.queryFn || db.query,
  });
  const score = pullbackScore(inputs.reference);
  const candidates = pullbackCandidates(inputs.reference);
  const ref = signalRef({
    date: now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }),
    snapshotHash: inputs.reference?.snapshotHash || null,
    briefRef: briefStatus.brief?.briefRef || null,
    pullbackScore: score.total,
  });
  const route = buildJaenongPriorityRoute({
    signalRef: ref,
    createdAt: now.toISOString(),
    pullbackScore: score,
    pullbackCandidates: candidates,
    topVolumeCandidates: inputs.topVolumeCandidates,
    referenceSnapshot: inputs.reference,
    brief: briefStatus.brief,
    briefState: briefStatus.state,
    c17: options.c17 || {},
  });
  const recorded = options.write === true
    ? await recordJaenongRouteShadow(route, deps.runFn || db.run)
    : { recorded: false, skipped: true, reason: 'dry_run', shadowOnly: true };
  return {
    ok: true,
    mode: options.write === true ? 'shadow_write' : 'dry_run',
    route,
    recorded,
    inputs: {
      referenceSnapshotHash: inputs.reference?.snapshotHash || null,
      pullbackCandidates: candidates.length,
      topVolumeCandidates: inputs.topVolumeCandidates.length,
      briefState: briefStatus.state.status,
    },
    safety: {
      liveTradeConnected: false,
      orderPath: null,
      writeRequiresConfirmation: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
  void runCliMain({
    run: () => runJaenongRouteShadow({
      fixture: argv.includes('--fixture'),
      write: argv.includes('--write'),
      confirm: value('confirm'),
    }),
    onSuccess: (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'jaenong route shadow failed:',
  });
}
