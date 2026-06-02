// @ts-nocheck
/**
 * SHADOW-only vault RAG comparison for Luna agent evolution.
 *
 * This module never mutates live decisions or agent_curriculum_state. It writes
 * only investment.luna_vault_shadow_adjustments when explicitly enabled.
 */

import * as db from './db.ts';
import { searchVault } from '../../sigma/vault/vault-search.ts';

const NEGATIVE_TYPES = new Set(['penalize', 'disable']);
const POSITIVE_TYPES = new Set(['boost', 'enable']);

function normalizeBool(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

function compactText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isVaultShadowAdjustEnabled(env = process.env): boolean {
  return normalizeBool(
    env.VAULT_SHADOW_ADJUST_ENABLED ?? env.LUNA_VAULT_SHADOW_ADJUST_ENABLED,
    false,
  );
}

async function ensureVaultShadowTable(): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_adjustments (
      id                   BIGSERIAL PRIMARY KEY,
      week                 TEXT,
      pattern_key          TEXT NOT NULL,
      market               TEXT,
      regime               TEXT,
      base_adjustment_type TEXT NOT NULL,
      vault_shadow_type    TEXT,
      vault_evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
      agreement            BOOLEAN,
      confidence           DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_pattern ON investment.luna_vault_shadow_adjustments (pattern_key, created_at DESC)`).catch(() => null);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_market ON investment.luna_vault_shadow_adjustments (market, created_at DESC)`).catch(() => null);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_agreement ON investment.luna_vault_shadow_adjustments (agreement, created_at DESC)`).catch(() => null);
}

function adjustmentDirection(type: string | null | undefined): 'negative' | 'positive' | 'none' {
  const normalized = String(type || '').toLowerCase();
  if (NEGATIVE_TYPES.has(normalized)) return 'negative';
  if (POSITIVE_TYPES.has(normalized)) return 'positive';
  return 'none';
}

function queryForAdjustment(adjustment: any): string {
  const parts = [
    adjustment?.market,
    adjustment?.regime,
    String(adjustment?.target || '').replace(/[:_|/]/g, ' '),
    adjustment?.reason,
  ].filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function numericSignalFromPayload(payload: any): number | null {
  const candidates = [
    payload?.pnlPercent,
    payload?.pnl_percent,
    payload?.pnlNet,
    payload?.pnl_net,
    payload?.pnlAmount,
    payload?.pnl_amount,
    payload?.virtualReturn,
    payload?.virtual_return,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return null;
}

function textSignal(item: any): number {
  const text = [
    item?.title,
    item?.contentPreview,
    compactText(item?.meta?.payload),
  ].join(' ').toLowerCase();
  let score = 0;
  if (/(손실|loss|bad|stop|stop_loss|no_position|duplicate_open|risk)/i.test(text)) score -= 1;
  if (/(수익|profit|win|good|approved|take_profit|tp|gain)/i.test(text)) score += 1;
  return score;
}

function summarizeEvidence(results: any[]) {
  const samples = results.slice(0, 5).map((item) => {
    const payload = item?.meta?.payload || {};
    return {
      id: item.id,
      title: item.title,
      source: item.source,
      similarity: Number(item.similarity || 0),
      pnlSignal: numericSignalFromPayload(payload),
      contentPreview: item.contentPreview,
      sourceId: item?.meta?.sourceId || null,
    };
  });

  const numericSignals = samples
    .map((item) => item.pnlSignal)
    .filter((value) => value != null && Number.isFinite(Number(value)));
  const avgPnlSignal = numericSignals.length
    ? numericSignals.reduce((sum, value) => sum + Number(value), 0) / numericSignals.length
    : null;
  const textScore = results.reduce((sum, item) => sum + textSignal(item), 0);
  const avgSimilarity = results.length
    ? results.reduce((sum, item) => sum + Number(item.similarity || 0), 0) / results.length
    : 0;

  let direction: 'negative' | 'positive' | 'none' = 'none';
  if (avgPnlSignal != null && avgPnlSignal < 0) direction = 'negative';
  else if (avgPnlSignal != null && avgPnlSignal > 0) direction = 'positive';
  else if (textScore < 0) direction = 'negative';
  else if (textScore > 0) direction = 'positive';

  const vaultShadowType = direction === 'negative'
    ? (avgPnlSignal != null && avgPnlSignal <= -5 ? 'disable' : 'penalize')
    : direction === 'positive'
      ? (avgPnlSignal != null && avgPnlSignal >= 5 ? 'enable' : 'boost')
      : 'insufficient_evidence';

  const confidence = direction === 'none'
    ? 0
    : Math.min(0.95, Math.max(0.1, avgSimilarity) + Math.min(0.2, Math.abs(textScore) * 0.03));

  return {
    vaultShadowType,
    confidence: Number(confidence.toFixed(4)),
    evidence: {
      count: results.length,
      avgSimilarity: Number(avgSimilarity.toFixed(6)),
      avgPnlSignal,
      numericSignalCount: numericSignals.length,
      textScore,
      samples,
    },
  };
}

async function recordShadowAdjustment({
  week,
  adjustment,
  vaultShadowType,
  confidence,
  evidence,
}: {
  week: string;
  adjustment: any;
  vaultShadowType: string;
  confidence: number;
  evidence: Record<string, unknown>;
}) {
  const baseDirection = adjustmentDirection(adjustment.adjustmentType);
  const vaultDirection = adjustmentDirection(vaultShadowType);
  const agreement = vaultDirection === 'none' ? null : baseDirection === vaultDirection;
  await db.run(`
    INSERT INTO investment.luna_vault_shadow_adjustments
      (week, pattern_key, market, regime, base_adjustment_type,
       vault_shadow_type, vault_evidence, agreement, confidence, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,NOW())
  `, [
    week,
    adjustment.target,
    adjustment.market || null,
    adjustment.regime || null,
    adjustment.adjustmentType,
    vaultShadowType,
    JSON.stringify(evidence),
    agreement,
    confidence,
  ]);
  return agreement;
}

export async function recordVaultShadowAdjustments({
  week,
  adjustments,
  env = process.env,
}: {
  week: string;
  adjustments: any[];
  env?: Record<string, unknown>;
}) {
  if (!isVaultShadowAdjustEnabled(env)) {
    return { enabled: false, attempted: 0, recorded: 0, skipped: 0, warnings: [], agreementRate: null };
  }

  await ensureVaultShadowTable();

  const topK = Math.floor(boundedNumber(env.VAULT_SHADOW_ADJUST_TOP_K ?? env.LUNA_VAULT_SHADOW_ADJUST_TOP_K, 5, 1, 10));
  const minSimilarity = boundedNumber(env.VAULT_SHADOW_ADJUST_MIN_SIM ?? env.LUNA_VAULT_SHADOW_ADJUST_MIN_SIM, 0.25, -1, 1);
  const warnings: string[] = [];
  let recorded = 0;
  let skipped = 0;
  let agreements = 0;
  let comparable = 0;

  for (const adjustment of adjustments.slice(0, 24)) {
    const query = queryForAdjustment(adjustment);
    if (!query) {
      skipped += 1;
      continue;
    }

    const search = await searchVault(query, {
      topK,
      minSimilarity,
      sourceKinds: ['luna_trade_journal', 'luna_trade_review'],
    });
    if (!search.ok) {
      skipped += 1;
      warnings.push(`${adjustment.target}:${search.warning || 'search_failed'}`);
      continue;
    }

    const summary = summarizeEvidence(search.results || []);
    const agreement = await recordShadowAdjustment({
      week,
      adjustment,
      vaultShadowType: summary.vaultShadowType,
      confidence: summary.confidence,
      evidence: {
        query,
        topK,
        minSimilarity,
        base: {
          adjustmentType: adjustment.adjustmentType,
          confidence: adjustment.confidence,
          reason: adjustment.reason,
        },
        vault: summary.evidence,
      },
    });
    recorded += 1;
    if (agreement != null) {
      comparable += 1;
      if (agreement) agreements += 1;
    }
  }

  return {
    enabled: true,
    attempted: Math.min(adjustments.length, 24),
    recorded,
    skipped,
    warnings: warnings.slice(0, 10),
    agreementRate: comparable > 0 ? Number((agreements / comparable).toFixed(4)) : null,
  };
}

export default { isVaultShadowAdjustEnabled, recordVaultShadowAdjustments };
