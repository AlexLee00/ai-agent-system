// @ts-nocheck

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function compactJson(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

export function buildLunaLearnedBiasFeedInput(row = {}) {
  const regime = String(row.regime || 'RANGING').trim().toUpperCase();
  const symbol = `__REGIME_${regime}__`;
  const fusionWeights = row.fusion_weights || row.fusionWeights || {};
  const signalWeights = row.signal_weights || row.signalWeights || {};
  const universeWeights = row.universe_weights || row.universeWeights || {};
  return {
    team: 'luna',
    agent: 'regime-weight-learner',
    sourceKind: 'luna_learned_bias' as const,
    sourceId: row.id,
    createdAt: row.created_at || row.createdAt,
    text: [
      `learned bias ${symbol}`,
      `regime=${regime}`,
      `unit=ratio_0_1`,
      `signal=${compactJson(signalWeights)}`,
      `fusion=${compactJson(fusionWeights)}`,
      `universe=${compactJson(universeWeights)}`,
      `totalTrades=${Number(row.total_trades ?? row.totalTrades ?? 0)}`,
    ].join(' '),
    payload: {
      snapshotId: String(row.id ?? ''),
      symbol,
      regime,
      weightUnit: 'ratio_0_1',
      fusionWeights,
      signalWeights,
      universeWeights,
      winRate: Number(row.win_rate ?? row.winRate ?? 0),
      profitFactor: Number(row.profit_factor ?? row.profitFactor ?? 0),
      performanceMetric: Number(row.performance_metric ?? row.performanceMetric ?? 0),
      totalTrades: Number(row.total_trades ?? row.totalTrades ?? 0),
      learnRate: Number(row.learn_rate ?? row.learnRate ?? 0),
    },
  };
}

async function defaultQueryReadonly(schema, sql, params) {
  const pgPool = require(path.join(repoRoot, 'packages/core/lib/pg-pool.js'));
  return pgPool.queryReadonly(schema, sql, params);
}

export async function fetchLunaLearnedBiasVaultRows(regime = null, options = {}) {
  const queryReadonly = options.queryReadonly || defaultQueryReadonly;
  const normalizedRegime = regime ? String(regime).trim().toUpperCase() : null;
  return queryReadonly('sigma', `
    SELECT id, meta, time_stage, created_at, updated_at
      FROM sigma.vault_entries
     WHERE source = 'luna_learned_bias'
       AND COALESCE(status, 'captured') <> 'archived'
       AND COALESCE(meta->>'constitutionAllowed', 'true') <> 'false'
       AND ($1::text IS NULL OR UPPER(meta->'payload'->>'regime') = $1)
     ORDER BY COALESCE(meta->>'createdAt', created_at::text) DESC,
              created_at DESC,
              id DESC
     LIMIT 500
  `, [normalizedRegime]);
}

export default {
  buildLunaLearnedBiasFeedInput,
  fetchLunaLearnedBiasVaultRows,
};
