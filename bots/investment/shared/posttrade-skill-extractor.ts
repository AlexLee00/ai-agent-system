// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.ts';
import { getPosttradeFeedbackRuntimeConfig } from './runtime-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
function getSkillRoot() {
  return process.env.LUNA_POSTTRADE_SKILL_FILE_MIRROR_ROOT
    || path.join(PROJECT_ROOT, 'packages', 'core', 'lib', 'skills', 'investment', 'luna');
}

function normalizeMarket(market: unknown) {
  const raw = String(market || 'all').trim().toLowerCase();
  if (raw === 'binance') return 'crypto';
  if (raw === 'kis') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  if (raw === 'crypto' || raw === 'domestic' || raw === 'overseas' || raw === 'all') return raw;
  return 'all';
}

function slugify(input: string) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'pattern';
}

function buildPatternKey(row: any) {
  const market = normalizeMarket(row?.market || row?.exchange);
  const setup = String(row?.setup_type || 'unknown').trim().toLowerCase() || 'unknown';
  const regime = String(row?.regime || 'unknown').trim().toLowerCase() || 'unknown';
  const direction = String(row?.direction || 'unknown').trim().toLowerCase() || 'unknown';
  return `${market}:${setup}:${regime}:${direction}`;
}

function resolveSkillAgents(bucket: any) {
  const targets = new Set<string>(['all', 'luna']);
  if (String(bucket?.skillType || '').toLowerCase() === 'avoid') targets.add('nemesis');
  if (String(bucket?.setupType || '').toLowerCase().includes('sentiment')) targets.add('sophia');
  return [...targets];
}

function buildSkillDoc({
  title,
  summary,
  invocationCount,
  successRate,
  winCount,
  lossCount,
  sampleTradeIds = [],
  metadata = {},
}) {
  return [
    `# ${title}`,
    '',
    `- summary: ${summary}`,
    `- invocation_count: ${invocationCount}`,
    `- success_rate: ${Number(successRate || 0).toFixed(4)}`,
    `- wins: ${winCount}`,
    `- losses: ${lossCount}`,
    `- sample_trade_ids: ${(sampleTradeIds || []).join(',') || '-'}`,
    '',
    '## metadata',
    '```json',
    JSON.stringify(metadata || {}, null, 2),
    '```',
    '',
  ].join('\n');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function maybeMirrorSkillFile({
  agentName,
  market,
  skillType,
  patternKey,
  title,
  summary,
  invocationCount,
  successRate,
  winCount,
  lossCount,
  sourceTradeIds,
  metadata,
  enabled,
}) {
  if (!enabled) return null;
  const safeAgent = String(agentName || 'all').trim().toLowerCase() || 'all';
  const safeMarket = normalizeMarket(market);
  const folder = path.join(getSkillRoot(), safeAgent, safeMarket);
  ensureDir(folder);
  const fileName = `${skillType.toUpperCase()}_${slugify(patternKey)}.md`;
  const filePath = path.join(folder, fileName);
  const content = buildSkillDoc({
    title,
    summary,
    invocationCount,
    successRate,
    winCount,
    lossCount,
    sampleTradeIds: sourceTradeIds,
    metadata,
  });
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

async function loadSkillCandidates({ days = 14, market = 'all' } = {}) {
  const safeDays = Math.max(1, Math.round(Number(days || 14)));
  const normalizedMarket = normalizeMarket(market);
  const params: unknown[] = [safeDays];
  let marketClause = '';
  if (normalizedMarket !== 'all') {
    params.push(normalizedMarket);
    marketClause = `
      AND COALESCE(
        th.market,
        CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END
      ) = $2
    `;
  }
  const rows = await db.query(
    `SELECT
       tqe.trade_id,
       tqe.category,
       tqe.overall_score,
       th.symbol,
       th.exchange,
       th.market,
       th.direction,
       COALESCE(NULLIF(th.setup_type, ''), 'unknown') AS setup_type,
       COALESCE(tr.regime, 'unknown') AS regime
     FROM investment.trade_quality_evaluations tqe
     JOIN investment.trade_history th ON th.id = tqe.trade_id
     LEFT JOIN investment.trade_review tr ON tr.trade_id = tqe.trade_id
     WHERE tqe.evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
       AND tqe.category IN ('preferred', 'rejected')
       ${marketClause}
     ORDER BY tqe.evaluated_at DESC`,
    params,
  ).catch(() => []);
  return rows || [];
}

export async function extractPosttradeSkills({
  days = 14,
  market = 'all',
  dryRun = false,
} = {}) {
  const cfg = getPosttradeFeedbackRuntimeConfig();
  const phaseCfg = cfg?.skill_extraction || {};
  const minOccurrences = Math.max(2, Math.round(Number(phaseCfg?.min_occurrences || 3)));
  const mirrorEnabled = phaseCfg?.file_mirror === true;
  const rows = await loadSkillCandidates({ days, market });

  const groups = new Map<string, any>();
  for (const row of rows) {
    const patternKey = buildPatternKey(row);
    const skillType = row.category === 'preferred' ? 'success' : 'avoid';
    const key = `${skillType}:${patternKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        market: normalizeMarket(row.market || row.exchange),
        skillType,
        patternKey,
        wins: 0,
        losses: 0,
        trades: [],
        setupType: row.setup_type || 'unknown',
        regime: row.regime || 'unknown',
        direction: row.direction || 'unknown',
      });
    }
    const bucket = groups.get(key);
    bucket.trades.push(row);
    if (Number(row.overall_score || 0) >= 0.7) bucket.wins += 1;
    if (Number(row.overall_score || 0) <= 0.4 || row.category === 'rejected') bucket.losses += 1;
  }

  const upserts = [];
  const mirrored = [];

  for (const bucket of groups.values()) {
    const invocationCount = bucket.trades.length;
    if (invocationCount < minOccurrences) continue;
    const winCount = Math.max(0, Number(bucket.wins || 0));
    const lossCount = Math.max(0, Number(bucket.losses || 0));
    const successRate = invocationCount > 0 ? winCount / invocationCount : 0;
    const sourceTradeIds = bucket.trades.map((item) => Number(item.trade_id)).filter((id) => Number.isFinite(id)).slice(0, 20);
    const title = `${bucket.skillType === 'success' ? 'SUCCESS' : 'AVOID'} ${bucket.patternKey}`;
    const summary = `${bucket.market} ${bucket.setupType} / ${bucket.regime} / ${bucket.direction} 패턴 ${invocationCount}건 기반`;
    const metadata = {
      setup_type: bucket.setupType,
      regime: bucket.regime,
      direction: bucket.direction,
      min_occurrences: minOccurrences,
      generated_at: new Date().toISOString(),
    };

    const targetAgents = resolveSkillAgents(bucket);
    if (!dryRun) {
      for (const agentName of targetAgents) {
        const upserted = await db.upsertPosttradeSkill({
          market: bucket.market,
          agentName,
          skillType: bucket.skillType,
          patternKey: bucket.patternKey,
          title,
          summary,
          invocationCount,
          successRate,
          winCount,
          lossCount,
          sourceTradeIds,
          metadata: { ...(metadata || {}), agent_name: agentName },
        });
        upserts.push(upserted);
        const filePath = maybeMirrorSkillFile({
          agentName,
          market: bucket.market,
          skillType: bucket.skillType,
          patternKey: bucket.patternKey,
          title,
          summary,
          invocationCount,
          successRate,
          winCount,
          lossCount,
          sourceTradeIds,
          metadata: { ...(metadata || {}), agent_name: agentName },
          enabled: mirrorEnabled,
        });
        if (filePath) mirrored.push(filePath);
      }
    } else {
      for (const agentName of targetAgents) {
        upserts.push({
          market: bucket.market,
          agent_name: agentName,
          skill_type: bucket.skillType,
          pattern_key: bucket.patternKey,
        });
      }
    }
  }

  return {
    ok: true,
    market: normalizeMarket(market),
    days: Number(days || 14),
    minOccurrences,
    candidates: rows.length,
    extracted: upserts.length,
    mirroredFiles: mirrored,
    skills: upserts,
  };
}

export async function mirrorExistingPosttradeSkills({
  agentName = null,
  market = 'all',
  limit = 100,
  dryRun = false,
} = {}) {
  const rows = await db.getRecentPosttradeSkills({
    market: normalizeMarket(market) === 'all' ? null : normalizeMarket(market),
    agentName: agentName ? String(agentName) : null,
    limit,
  });
  const mirrored = [];
  for (const row of rows || []) {
    const sourceTradeIds = Array.isArray(row.source_trade_ids)
      ? row.source_trade_ids
      : [];
    const filePath = maybeMirrorSkillFile({
      agentName: row.agent_name || 'all',
      market: row.market,
      skillType: row.skill_type,
      patternKey: row.pattern_key,
      title: row.title,
      summary: row.summary,
      invocationCount: row.invocation_count,
      successRate: row.success_rate,
      winCount: row.win_count,
      lossCount: row.loss_count,
      sourceTradeIds,
      metadata: row.metadata || {},
      enabled: !dryRun,
    });
    if (filePath || dryRun) {
      mirrored.push(filePath || path.join(
        getSkillRoot(),
        String(row.agent_name || 'all').toLowerCase(),
        normalizeMarket(row.market),
        `${String(row.skill_type || 'skill').toUpperCase()}_${slugify(row.pattern_key)}.md`,
      ));
    }
  }
  return {
    ok: true,
    market: normalizeMarket(market),
    checked: rows.length,
    mirroredFiles: mirrored,
    dryRun,
  };
}
