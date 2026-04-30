// @ts-nocheck
/**
 * Failed signal reflexion trigger.
 *
 * Default contract:
 * - disabled unless LUNA_FAILED_SIGNAL_REFLEXION_AUTO=true or explicit force.
 * - dry-run unless caller passes dryRun=false.
 * - stores failed signals with a deterministic negative synthetic trade_id so
 *   existing luna_failure_reflexions remains idempotent without schema changes.
 */

import { createHash } from 'node:crypto';
import * as db from './db.ts';
import { buildFailedSignalReflexion } from './failed-signal-reflexion.ts';

export const FAILED_SIGNAL_REFLEXION_CONFIRM = 'luna-failed-reflexion-backfill';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

export function isFailedSignalReflexionAutoEnabled() {
  return boolEnv('LUNA_FAILED_SIGNAL_REFLEXION_AUTO', false);
}

export function isFailedSignalBackfillDryRunDefault() {
  return boolEnv('LUNA_FAILED_SIGNAL_REFLEXION_BACKFILL_DRY_RUN', true);
}

export function buildFailedSignalSyntheticTradeId(signal = {}) {
  const source = String(signal.id || signal.signal_id || `${signal.symbol || 'unknown'}:${signal.created_at || ''}`);
  const hex = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const value = Number.parseInt(hex, 16) % 2_000_000_000;
  return -Math.max(1, value);
}

export function buildFailedSignalReflexionEvent(signal = {}, context = {}) {
  const reflexion = buildFailedSignalReflexion(signal, { dryRun: context.dryRun !== false });
  const syntheticTradeId = buildFailedSignalSyntheticTradeId(signal);
  const signalId = signal.id ?? signal.signal_id ?? null;
  return {
    ok: true,
    type: 'failed_signal_reflexion',
    dryRun: context.dryRun !== false,
    syntheticTradeId,
    signalId,
    symbol: signal.symbol ?? null,
    exchange: signal.exchange ?? signal.market ?? null,
    classification: reflexion.classification,
    lesson: reflexion.lesson,
    fiveWhy: [
      { q: '왜 signal이 실패했나?', a: `${reflexion.classification.kind}로 분류되었습니다.` },
      { q: '왜 즉시 재시도하지 않나?', a: reflexion.classification.retryable ? '쿨다운/가드 후 재시도해야 합니다.' : '수동 검증 전 재시도하면 장부 부정합 위험이 있습니다.' },
      { q: '다음 진입 전에 무엇을 확인해야 하나?', a: reflexion.lesson.correctiveAction },
      { q: '어떤 패턴을 피해야 하나?', a: reflexion.lesson.promptHint },
      { q: '근거는 무엇인가?', a: JSON.stringify(reflexion.classification.evidence || {}).slice(0, 220) },
    ],
    stageAttribution: {
      signal_failure: 1,
      classification: reflexion.classification.kind,
      retryable: reflexion.classification.retryable,
    },
    hindsight: `[failed-signal] ${signal.symbol || 'unknown'} 실패는 ${reflexion.classification.kind} 근거가 보강되기 전 재진입하지 말아야 한다.`,
    avoidPattern: {
      symbol_pattern: String(signal.symbol || 'unknown').split('/')[0] || 'unknown',
      avoid_action: String(signal.action || 'buy').toLowerCase().includes('sell') ? 'short_entry' : 'long_entry',
      reason: reflexion.lesson.promptHint,
      evidence: [signalId].filter(Boolean),
      source: 'failed-signal-reflexion-trigger',
    },
  };
}

async function persistFailedSignalReflexion(event) {
  await db.run(
    `INSERT INTO investment.luna_failure_reflexions
       (trade_id, five_why, stage_attribution, hindsight, avoid_pattern)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb)
     ON CONFLICT (trade_id) DO UPDATE SET
       five_why = EXCLUDED.five_why,
       stage_attribution = EXCLUDED.stage_attribution,
       hindsight = EXCLUDED.hindsight,
       avoid_pattern = EXCLUDED.avoid_pattern,
       created_at = NOW()`,
    [
      event.syntheticTradeId,
      JSON.stringify(event.fiveWhy),
      JSON.stringify(event.stageAttribution),
      event.hindsight,
      JSON.stringify(event.avoidPattern),
    ],
  );
  await db.run(
    `INSERT INTO investment.luna_rag_documents
       (owner_agent, category, market, symbol, content, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      'luna',
      'rag_experience',
      event.exchange || 'unknown',
      event.symbol,
      event.hindsight,
      JSON.stringify({
        source: 'failed-signal-reflexion-trigger',
        signalId: event.signalId,
        syntheticTradeId: event.syntheticTradeId,
        classification: event.classification?.kind,
      }),
    ],
  ).catch(() => {});
  return { persisted: true, tradeId: event.syntheticTradeId };
}

export async function onSignalFailed(signal = {}, opts = {}) {
  const enabled = opts.force === true || isFailedSignalReflexionAutoEnabled();
  const dryRun = opts.dryRun !== false;
  const event = buildFailedSignalReflexionEvent(signal, { dryRun });
  if (!enabled) {
    return {
      ok: true,
      status: 'disabled',
      dryRun: true,
      enabled: false,
      event,
      persisted: false,
    };
  }
  if (dryRun) {
    return {
      ok: true,
      status: 'dry_run',
      dryRun: true,
      enabled: true,
      event,
      persisted: false,
    };
  }
  const persistFn = opts.persistFn || persistFailedSignalReflexion;
  const persisted = await persistFn(event);
  return {
    ok: true,
    status: 'persisted',
    dryRun: false,
    enabled: true,
    event,
    persisted: true,
    evidence: persisted,
  };
}

export function buildFailedSignalReflexionBackfillPlan({
  signals = [],
  limit = signals.length,
  dryRun = true,
} = {}) {
  const selected = signals.slice(0, Math.max(0, Number(limit || 0)));
  const events = selected.map((signal) => buildFailedSignalReflexionEvent(signal, { dryRun }));
  const byKind = events.reduce((acc, event) => {
    const kind = event.classification?.kind || 'unknown';
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    dryRun,
    totalInput: signals.length,
    selected: selected.length,
    wouldPersist: dryRun ? 0 : selected.length,
    byKind,
    events,
  };
}

export default {
  FAILED_SIGNAL_REFLEXION_CONFIRM,
  isFailedSignalReflexionAutoEnabled,
  isFailedSignalBackfillDryRunDefault,
  buildFailedSignalSyntheticTradeId,
  buildFailedSignalReflexionEvent,
  buildFailedSignalReflexionBackfillPlan,
  onSignalFailed,
};
