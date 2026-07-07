#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pgPool = require('../../../packages/core/lib/pg-pool.ts');
import { listLLMSelectorKeys, selectLLMChain } from '../../../packages/core/lib/llm-model-selector.ts';
import { PROFILES } from '../lib/runtime-profiles.ts';

type SelectorUsage = {
  selectorKey: string;
  file: string;
  line: number;
};

type RoutingPurposeRow = {
  caller_team: string | null;
  runtime_purpose: string | null;
  selector_key: string | null;
  runtime_profile: string | null;
  routing_source: string | null;
  call_count: number;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DAYS = 14;
const SOURCE_EXTENSIONS = new Set(['.ts', '.js', '.cjs', '.mjs']);
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'output',
]);
const IGNORED_SELECTOR_KEYS = new Set([
  'hub.adhoc.chain',
]);

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function positiveInt(value: unknown, fallback: number, min = 1, max = 365): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalize(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function shouldSkipPath(filePath: string): boolean {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith('..')) return true;
  if (relative.includes(`${path.sep}__tests__${path.sep}`)) return true;
  if (relative.includes(`${path.sep}fixtures${path.sep}`)) return true;
  if (relative.includes(`${path.sep}output${path.sep}`)) return true;
  if (relative.includes(`${path.sep}archive${path.sep}`)) return true;
  if (/(\b|[-_.])(smoke|test|fixture)([-_.]|\b)/i.test(path.basename(relative))) return true;
  return false;
}

function walkSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkSourceFiles(path.join(dir, entry.name), files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    const filePath = path.join(dir, entry.name);
    if (shouldSkipPath(filePath)) continue;
    files.push(filePath);
  }
  return files;
}

export function extractSelectorUsagesFromSource(root = repoRoot): SelectorUsage[] {
  const usages: SelectorUsage[] = [];
  const regexes = [
    /\bselectorKey\s*:\s*['"]([^'"]+)['"]/g,
    /\bselector_key\s*:\s*['"]([^'"]+)['"]/g,
  ];
  for (const filePath of walkSourceFiles(root)) {
    const relative = path.relative(root, filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const regex of regexes) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line))) {
          const selectorKey = String(match[1] || '').trim();
          if (!selectorKey || IGNORED_SELECTOR_KEYS.has(selectorKey)) continue;
          usages.push({ selectorKey, file: relative, line: index + 1 });
        }
      }
    });
  }
  return usages;
}

function selectorResolves(selectorKey: string): { ok: boolean; error: string | null } {
  try {
    const chain = selectLLMChain(selectorKey, { selectorVersion: 'v3.0_oauth_4', rolloutPercent: 100 });
    if (!Array.isArray(chain) || chain.length === 0) return { ok: false, error: 'empty_chain' };
    return { ok: true, error: null };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function runtimePurposeRegistered(team: string | null, purpose: string | null): boolean {
  const normalizedTeam = normalize(team);
  const normalizedPurpose = normalize(purpose || 'default') || 'default';
  return Boolean(PROFILES?.[normalizedTeam]?.[normalizedPurpose]);
}

export async function fetchRoutingPurposeRows(days = DEFAULT_DAYS): Promise<{ rows: RoutingPurposeRow[]; error: string | null }> {
  try {
    const rows = await pgPool.queryReadonly<RoutingPurposeRow>('public', `
      SELECT
        caller_team,
        runtime_purpose,
        selector_key,
        runtime_profile,
        routing_source,
        COUNT(*)::int AS call_count
      FROM public.llm_routing_log
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY 1,2,3,4,5
      ORDER BY call_count DESC
      LIMIT 500
    `, [days]);
    return { rows, error: null };
  } catch (error: any) {
    return { rows: [], error: error?.message || String(error) };
  }
}

export async function buildLlmPurposeAlignmentReport(options: { days?: number; noDb?: boolean } = {}) {
  const days = positiveInt(options.days, DEFAULT_DAYS);
  const usages = extractSelectorUsagesFromSource();
  const usageGroups = new Map<string, SelectorUsage[]>();
  for (const usage of usages) {
    if (!usageGroups.has(usage.selectorKey)) usageGroups.set(usage.selectorKey, []);
    usageGroups.get(usage.selectorKey)!.push(usage);
  }

  const unresolvedSelectors = Array.from(usageGroups.entries())
    .map(([selectorKey, locations]) => ({ selectorKey, locations, ...selectorResolves(selectorKey) }))
    .filter((entry) => !entry.ok)
    .sort((a, b) => a.selectorKey.localeCompare(b.selectorKey));

  const registeredSelectorKeys = new Set(listLLMSelectorKeys());
  const runtimeProfileSelectors = new Set<string>();
  for (const teamProfiles of Object.values(PROFILES || {})) {
    for (const profile of Object.values(teamProfiles as Record<string, any>)) {
      if (profile?.selector_key) runtimeProfileSelectors.add(String(profile.selector_key));
    }
  }

  const routing = options.noDb
    ? { rows: [], error: 'skipped_by_no_db' }
    : await fetchRoutingPurposeRows(days);
  const routingUnresolvedSelectors = routing.rows
    .filter((row) => row.selector_key && !registeredSelectorKeys.has(String(row.selector_key)))
    .map((row) => ({ ...row, reason: 'selector_key_not_registered' }));
  const routingDefaultedPurposes = routing.rows
    .filter((row) => (
      normalize(row.routing_source) === 'hub_default'
      || normalize(row.runtime_profile) === 'hub.default'
      || (normalize(row.selector_key) === 'hub._default' && !runtimePurposeRegistered(row.caller_team, row.runtime_purpose))
    ))
    .map((row) => ({ ...row, reason: 'runtime_purpose_defaulted_or_unregistered' }));

  return {
    ok: unresolvedSelectors.length === 0 && routingUnresolvedSelectors.length === 0 && routingDefaultedPurposes.length === 0,
    generatedAt: new Date().toISOString(),
    days,
    staticSelectorUsageCount: usages.length,
    staticSelectorKeyCount: usageGroups.size,
    registeredSelectorKeyCount: registeredSelectorKeys.size,
    runtimeProfileSelectorCount: runtimeProfileSelectors.size,
    unresolvedSelectors,
    routing: {
      checked: !options.noDb,
      error: routing.error,
      rowCount: routing.rows.length,
      unresolvedSelectors: routingUnresolvedSelectors,
      defaultedPurposes: routingDefaultedPurposes,
    },
  };
}

async function main() {
  const days = positiveInt(argValue('--days', String(DEFAULT_DAYS)), DEFAULT_DAYS);
  const noDb = process.argv.includes('--no-db');
  const failOnMissing = process.argv.includes('--fail-on-missing');
  const report = await buildLlmPurposeAlignmentReport({ days, noDb });
  console.log(JSON.stringify(report, null, 2));
  if (failOnMissing && !report.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`llm-purpose-alignment-audit failed: ${error?.message || error}`);
    process.exit(1);
  });
}
