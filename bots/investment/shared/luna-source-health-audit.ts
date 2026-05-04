// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.ex']);
const EXCLUDED_SEGMENTS = new Set(['node_modules', 'output', '.git']);

const CRITICAL_BUDGETS = [
  { file: 'team/hephaestos.ts', maxLines: 1000, owner: 'hephaestos' },
  { file: 'team/luna.ts', maxLines: 1400, owner: 'luna' },
  { file: 'shared/pipeline-decision-state-machine.ts', maxLines: 900, owner: 'luna' },
  { file: 'shared/capital-manager.ts', maxLines: 1400, owner: 'luna' },
];

const MARKETDATA_POLICY_IMPORTS = [
  'mcp/luna-marketdata-mcp/src/tools/binance-ws.ts',
  'mcp/luna-marketdata-mcp/src/tools/kis-ws-domestic.ts',
  'mcp/luna-marketdata-mcp/src/tools/kis-ws-overseas.ts',
  'mcp/luna-marketdata-mcp/src/tools/tradingview-ws.ts',
  'mcp/luna-marketdata-mcp/src/tools/order-book.ts',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(INVESTMENT_ROOT, file).replaceAll(path.sep, '/');
}

function lineCount(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
}

function readRel(file) {
  return fs.readFileSync(path.join(INVESTMENT_ROOT, file), 'utf8');
}

export function buildLunaSourceHealthAudit() {
  const files = walk(INVESTMENT_ROOT);
  const measured = files.map((file) => ({ file: rel(file), lines: lineCount(file) }));
  const largestFiles = measured
    .filter((row) => !row.file.startsWith('scripts/'))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 15);

  const budgets = CRITICAL_BUDGETS.map((budget) => {
    const absolute = path.join(INVESTMENT_ROOT, budget.file);
    const lines = fs.existsSync(absolute) ? lineCount(absolute) : 0;
    return {
      ...budget,
      lines,
      ok: lines > 0 && lines <= budget.maxLines,
      overBy: Math.max(0, lines - budget.maxLines),
    };
  });

  const marketdataFallbackPolicy = MARKETDATA_POLICY_IMPORTS.map((file) => {
    const content = readRel(file);
    return {
      file,
      importsPolicy: content.includes("from './live-fallback-policy.ts'"),
      usesPolicy: content.includes('simulatedFallbackOrBlock'),
    };
  });

  const tsNoCheckFiles = measured.filter((row) => {
    if (!row.file.startsWith('mcp/luna-marketdata-mcp/')) return false;
    return readRel(row.file).includes('@ts-nocheck');
  }).map((row) => row.file);

  const blockers = [];
  for (const item of budgets) {
    if (!item.ok) blockers.push(`critical_file_budget:${item.file}:${item.lines}/${item.maxLines}`);
  }
  for (const item of marketdataFallbackPolicy) {
    if (!item.importsPolicy || !item.usesPolicy) blockers.push(`marketdata_live_fallback_policy_missing:${item.file}`);
  }

  const warnings = [];
  for (const row of largestFiles) {
    if (row.lines > 1500) warnings.push(`large_file_advisory:${row.file}:${row.lines}`);
  }
  if (tsNoCheckFiles.length > 0) warnings.push(`mcp_ts_nocheck_advisory:${tsNoCheckFiles.length}`);

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_source_health_guarded' : 'luna_source_health_blocked',
    checkedAt: new Date().toISOString(),
    blockers,
    warnings,
    summary: {
      sourceFiles: measured.length,
      largestFiles,
      criticalBudgets: budgets,
      marketdataFallbackPolicy,
      tsNoCheckFiles,
    },
    externalReferencePatterns: [
      'research_to_live_parity',
      'risk_first_position_control',
      'event_driven_market_data_boundary',
      'walk_forward_and_out_of_sample_validation',
    ],
  };
}
