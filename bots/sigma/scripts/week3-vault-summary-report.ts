#!/usr/bin/env node
// @ts-nocheck
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SIGMA_VAULT_ROOT, scanSigmaVault } from '../ts/lib/vault-manager.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGMA_ROOT = resolve(__dirname, '..');
const PROJECT_ROOT = resolve(SIGMA_ROOT, '../..');
const DEFAULT_OUTPUT_JSON = resolve(SIGMA_ROOT, 'output/week3-vault-summary-report.json');
const DEFAULT_OUTPUT_MD = resolve(SIGMA_ROOT, 'output/week3-vault-summary-report.md');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function queryRows(sql, params = []) {
  try {
    const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
    return await pgPool.query('sigma', sql, params);
  } catch (error) {
    return { error: String(error?.message || error), rows: [] };
  }
}

function normalizeRows(result) {
  if (Array.isArray(result)) return result;
  return result?.rows || [];
}

function fileVaultStats(root) {
  const rows = scanSigmaVault({ root });
  const byCategory = {};
  for (const row of rows) {
    const category = row.relativePath.split(path.sep)[0] || 'unknown';
    byCategory[category] = (byCategory[category] || 0) + 1;
  }
  return { total: rows.length, byCategory };
}

export async function runWeek3VaultSummaryReport(options = {}) {
  const days = Number(options.days || 7);
  const root = resolve(options.root || DEFAULT_SIGMA_VAULT_ROOT);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [categoryResult, auditResult, speedResult] = await Promise.all([
    queryRows(`
      SELECT para_category, count(*)::int AS total
        FROM sigma.vault_entries
       WHERE created_at > $1
       GROUP BY para_category
       ORDER BY para_category
    `, [since]),
    queryRows(`
      SELECT classifier,
             count(*)::int AS total,
             avg(confidence)::numeric(5,3) AS avg_confidence,
             count(*) FILTER (WHERE applied IS TRUE)::int AS applied,
             count(*) FILTER (WHERE dry_run IS TRUE)::int AS dry_run
        FROM sigma.vault_audit
       WHERE created_at > $1
       GROUP BY classifier
       ORDER BY classifier
    `, [since]),
    queryRows(`
      SELECT avg(extract(epoch FROM updated_at - created_at))::numeric(12,2) AS avg_processing_seconds
        FROM sigma.vault_entries
       WHERE created_at > $1
         AND updated_at IS NOT NULL
    `, [since]),
  ]);
  const categoryRows = normalizeRows(categoryResult);
  const auditRows = normalizeRows(auditResult);
  const speedRows = normalizeRows(speedResult);
  const fileStats = fileVaultStats(root);
  const byCategory = {};
  for (const row of categoryRows) byCategory[row.para_category] = Number(row.total || 0);
  const dbTotal = Object.values(byCategory).reduce((sum, value) => sum + Number(value || 0), 0);
  const recommendations = [];
  if (dbTotal === 0) recommendations.push('DB vault_entries 누적 없음 - inbox processor --write-db 또는 active mode 확인');
  if (fileStats.total === 0) recommendations.push('파일 vault 노트 없음 - 00-inbox 수집 루틴 확인');
  if (auditRows.length === 0) recommendations.push('vault_audit 누적 없음 - PARA 분류/이동 감사 로그 확인');

  return {
    ok: true,
    status: dbTotal > 0 || fileStats.total > 0 ? 'sigma_vault_observation_started' : 'sigma_vault_no_data',
    generatedAt: new Date().toISOString(),
    period: { days, since },
    root,
    db: {
      total: dbTotal,
      byCategory,
      categoryRows,
      auditRows,
      avgProcessingSeconds: Number(speedRows[0]?.avg_processing_seconds || 0),
      queryErrors: [categoryResult, auditResult, speedResult].filter((item) => item?.error).map((item) => item.error),
    },
    files: fileStats,
    promotion: {
      enoughObservation: dbTotal >= 20 || fileStats.total >= 20,
      status: dbTotal >= 20 || fileStats.total >= 20 ? 'vault_observation_ready' : 'vault_observation_continue',
    },
    recommendations,
  };
}

function formatReport(result) {
  const lines = [
    '# Week 3 Sigma Vault Summary',
    '',
    `- Generated: ${result.generatedAt}`,
    `- Period: ${result.period.days} days`,
    `- Status: ${result.status}`,
    `- DB entries: ${result.db.total}`,
    `- DB PARA: ${JSON.stringify(result.db.byCategory)}`,
    `- File notes: ${result.files.total}`,
    `- File PARA: ${JSON.stringify(result.files.byCategory)}`,
    `- Audit rows: ${result.db.auditRows.length}`,
    `- Avg processing seconds: ${result.db.avgProcessingSeconds}`,
    `- Promotion: ${result.promotion.status}`,
  ];
  if (result.recommendations.length) {
    lines.push('', '## Recommendations');
    for (const item of result.recommendations) lines.push(`- ${item}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const result = await runWeek3VaultSummaryReport({
    days: Number(argValue('days', '7')),
    root: argValue('root', DEFAULT_SIGMA_VAULT_ROOT),
  });
  const report = formatReport(result);
  if (hasFlag('write')) {
    fs.mkdirSync(path.dirname(DEFAULT_OUTPUT_JSON), { recursive: true });
    fs.writeFileSync(DEFAULT_OUTPUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(DEFAULT_OUTPUT_MD, report);
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(report.trim());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`week3-vault-summary-report error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runWeek3VaultSummaryReport };
