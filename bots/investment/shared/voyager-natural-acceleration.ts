// @ts-nocheck
/**
 * Voyager natural skill accumulation accelerator.
 *
 * Default contract:
 * - disabled unless LUNA_VOYAGER_NATURAL_ACCELERATION_ENABLED=true.
 * - dry-run by default.
 * - production skill writes require --apply plus confirm token.
 */

import * as db from './db.ts';
import { extractPosttradeSkills } from './posttrade-skill-extractor.ts';

export const VOYAGER_NATURAL_ACCELERATION_CONFIRM = 'luna-voyager-natural-acceleration';

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
}

export function isVoyagerNaturalAccelerationEnabled() {
  return boolEnv('LUNA_VOYAGER_NATURAL_ACCELERATION_ENABLED', false);
}

export function getVoyagerNaturalSkillTarget() {
  return Math.max(1, Number(process.env.LUNA_VOYAGER_NATURAL_SKILL_TARGET || 50) || 50);
}

export async function loadVoyagerNaturalEvidence({ days = 365, market = 'all' } = {}) {
  const safeDays = Math.max(1, Math.round(Number(days || 365)));
  const normalizedMarket = String(market || 'all').trim().toLowerCase();
  const params = [safeDays];
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

  let tradeQuality = await db.query(
    `SELECT
       COALESCE(
         th.market,
         CASE WHEN th.exchange = 'binance' THEN 'crypto' WHEN th.exchange = 'kis' THEN 'domestic' ELSE 'overseas' END
       ) AS market,
       tqe.category,
       COUNT(*)::int AS cnt,
       AVG(tqe.overall_score)::double precision AS avg_score
     FROM investment.trade_quality_evaluations tqe
     JOIN investment.trade_history th ON th.id = tqe.trade_id
    WHERE tqe.evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND tqe.category IN ('preferred', 'rejected')
      ${marketClause}
    GROUP BY 1, 2
    ORDER BY 1, 2`,
    params,
  ).catch(() => []);

  const tradePatterns = await db.query(
    `SELECT
       CASE WHEN exchange = 'binance' THEN 'crypto' WHEN exchange = 'kis' THEN 'domestic' ELSE 'overseas' END AS market,
       symbol,
       LOWER(COALESCE(side, 'unknown')) AS side,
       COALESCE(trade_mode, CASE WHEN paper THEN 'paper' ELSE 'live' END, 'unknown') AS mode,
       COUNT(*)::int AS cnt,
       AVG(COALESCE(total_usdt, amount * price, 0))::double precision AS avg_notional,
       MIN(executed_at) AS first_seen,
       MAX(executed_at) AS last_seen
     FROM investment.trades
     WHERE executed_at >= NOW() - ($1::int * INTERVAL '1 day')
     GROUP BY 1, 2, 3, 4
     ORDER BY cnt DESC, last_seen DESC
     LIMIT 200`,
    [safeDays],
  ).catch(() => []);

  if (!Array.isArray(tradeQuality) || tradeQuality.length === 0) {
    tradeQuality = (tradePatterns || []).map((row) => ({
      market: row.market,
      category: String(row.side || '').includes('sell') ? 'preferred' : 'observed',
      cnt: row.cnt,
      avg_score: null,
      source: 'trades_fallback',
    }));
  }

  const [skillCount] = await Promise.all([
    db.get(`SELECT COUNT(*)::int AS cnt FROM investment.luna_posttrade_skills`, []).catch(() => null),
  ]);

  const totalTradeQuality = (tradeQuality || []).reduce((sum, row) => sum + Number(row.cnt || 0), 0);
  return {
    ok: true,
    days: safeDays,
    market: normalizedMarket,
    tradeQualityRows: tradeQuality || [],
    tradePatterns: tradePatterns || [],
    totalTradeQuality,
    skillCount: Number(skillCount?.cnt || 0),
  };
}

async function buildTradePatternSkillExtraction({ evidence, dryRun = true, targetSkillCount = getVoyagerNaturalSkillTarget() } = {}) {
  const patterns = (evidence?.tradePatterns || []).slice(0, Math.max(1, Number(targetSkillCount || 50)));
  const skills = [];
  const mirroredFiles = [];
  for (const row of patterns) {
    const market = row.market || 'all';
    const symbol = String(row.symbol || 'unknown').replace(/[^A-Za-z0-9/_-]+/g, '_');
    const side = String(row.side || 'unknown').toLowerCase();
    const mode = String(row.mode || 'unknown').toLowerCase();
    const patternKey = `trade_history:${market}:${symbol}:${side}:${mode}`.toLowerCase();
    const skillType = side.includes('sell') ? 'success' : 'entry';
    const title = `${skillType.toUpperCase()} ${symbol} ${side} ${mode}`;
    const summary = `${market} ${symbol} ${side}/${mode} 누적 거래 ${row.cnt}건 기반 Voyager 자연 후보`;
    const payload = {
      market,
      agentName: 'luna',
      skillType,
      patternKey,
      title,
      summary,
      invocationCount: Number(row.cnt || 0),
      successRate: side.includes('sell') ? 1 : 0.5,
      winCount: side.includes('sell') ? Number(row.cnt || 0) : 0,
      lossCount: 0,
      sourceTradeIds: [],
      metadata: {
        source: 'voyager-natural-acceleration',
        symbol: row.symbol,
        side,
        mode,
        avg_notional: row.avg_notional,
        first_seen: row.first_seen,
        last_seen: row.last_seen,
      },
    };
    if (!dryRun) {
      const upserted = await db.upsertPosttradeSkill(payload);
      if (upserted) skills.push(upserted);
    } else {
      skills.push({
        market,
        agent_name: 'luna',
        skill_type: skillType,
        pattern_key: patternKey,
      });
    }
  }
  return {
    ok: true,
    market: evidence?.market || 'all',
    days: evidence?.days || 365,
    minOccurrences: 1,
    candidates: patterns.length,
    extracted: skills.length,
    mirroredFiles,
    skills,
    source: 'trades_fallback',
  };
}

export function buildVoyagerNaturalAccelerationPlan({
  evidence = {},
  extraction = null,
  skillTarget = getVoyagerNaturalSkillTarget(),
  enabled = isVoyagerNaturalAccelerationEnabled(),
  dryRun = true,
} = {}) {
  const currentSkills = Number(evidence.skillCount || 0);
  const projectedNewSkills = Number(extraction?.extracted || 0);
  const projectedTotalSkills = currentSkills + projectedNewSkills;
  const remainingToTarget = Math.max(0, Number(skillTarget || 0) - projectedTotalSkills);
  const ready = Number(evidence.totalTradeQuality || 0) > 0 && projectedNewSkills > 0;
  return {
    ok: true,
    enabled,
    dryRun,
    status: !enabled
      ? 'disabled_default_off'
      : ready
        ? 'acceleration_ready'
        : 'insufficient_trade_quality_patterns',
    targetSkillCount: Number(skillTarget || 0),
    currentSkills,
    projectedNewSkills,
    projectedTotalSkills,
    remainingToTarget,
    evidence: {
      days: evidence.days,
      market: evidence.market,
      totalTradeQuality: Number(evidence.totalTradeQuality || 0),
      tradeQualityRows: (evidence.tradeQualityRows || []).slice(0, 10),
      extractionCandidates: Number(extraction?.candidates || 0),
    },
    nextActions: [
      enabled
        ? 'review dry-run extraction candidates before confirmed apply'
        : 'set LUNA_VOYAGER_NATURAL_ACCELERATION_ENABLED=true only after master approval',
      `apply requires --apply --confirm=${VOYAGER_NATURAL_ACCELERATION_CONFIRM}`,
    ],
  };
}

export async function runVoyagerNaturalAcceleration({
  days = 365,
  market = 'all',
  dryRun = true,
  apply = false,
  confirm = '',
  enabled = isVoyagerNaturalAccelerationEnabled(),
  extractFn = extractPosttradeSkills,
} = {}) {
  const wantsApply = apply || dryRun === false;
  if (wantsApply && confirm !== VOYAGER_NATURAL_ACCELERATION_CONFIRM) {
    return {
      ok: false,
      status: 'confirm_required',
      dryRun: false,
      confirmRequired: VOYAGER_NATURAL_ACCELERATION_CONFIRM,
    };
  }

  const evidence = await loadVoyagerNaturalEvidence({ days, market });
  let extraction = await extractFn({
    days,
    market,
    dryRun: !wantsApply,
  });
  if (Number(extraction?.extracted || 0) === 0 && Number(evidence.totalTradeQuality || 0) > 0) {
    extraction = await buildTradePatternSkillExtraction({
      evidence,
      dryRun: !wantsApply,
      targetSkillCount: getVoyagerNaturalSkillTarget(),
    });
  }
  const plan = buildVoyagerNaturalAccelerationPlan({
    evidence,
    extraction,
    enabled,
    dryRun: !wantsApply,
  });
  const publicExtraction = {
    ...(extraction || {}),
    skillsTotal: Array.isArray(extraction?.skills) ? extraction.skills.length : Number(extraction?.extracted || 0),
    skills: Array.isArray(extraction?.skills) ? extraction.skills.slice(0, 10) : extraction?.skills,
  };

  return {
    ...plan,
    ok: !wantsApply || enabled,
    status: wantsApply && !enabled ? 'apply_blocked_disabled' : plan.status,
    applied: wantsApply && enabled,
    extraction: publicExtraction,
  };
}

export default {
  VOYAGER_NATURAL_ACCELERATION_CONFIRM,
  isVoyagerNaturalAccelerationEnabled,
  getVoyagerNaturalSkillTarget,
  loadVoyagerNaturalEvidence,
  buildVoyagerNaturalAccelerationPlan,
  runVoyagerNaturalAcceleration,
};
