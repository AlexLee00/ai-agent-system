'use strict';

const pgPool = require('../../../../packages/core/lib/pg-pool');
const rag = require('../../../../packages/core/lib/rag');
const kst = require('../../../../packages/core/lib/kst');
const { postAlarm } = require('../../../../packages/core/lib/openclaw-client');

const SCHEMA = 'sigma';

async function ensureSigmaTables() {
  await pgPool.run('public', `CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`, []);
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.daily_runs (
      id BIGSERIAL PRIMARY KEY,
      run_date DATE NOT NULL DEFAULT CURRENT_DATE,
      formation JSONB NOT NULL DEFAULT '{}'::jsonb,
      events JSONB NOT NULL DEFAULT '{}'::jsonb,
      report TEXT,
      insight_count INTEGER NOT NULL DEFAULT 0,
      feedback_count INTEGER NOT NULL DEFAULT 0,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_sigma_daily_runs_run_date
    ON ${SCHEMA}.daily_runs(run_date DESC, created_at DESC)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.feedback_effectiveness (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      feedback_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      target_team VARCHAR(20) NOT NULL,
      feedback_type VARCHAR(30) NOT NULL,
      content TEXT,
      formation JSONB DEFAULT '{}'::jsonb,
      analyst_used VARCHAR(30),
      before_metric JSONB DEFAULT '{}'::jsonb,
      after_metric JSONB DEFAULT '{}'::jsonb,
      effectiveness DOUBLE PRECISION,
      effective BOOLEAN,
      measured_at TIMESTAMPTZ,
      measured BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_sigma_fb_team
    ON ${SCHEMA}.feedback_effectiveness(target_team, feedback_date DESC)
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_sigma_fb_analyst
    ON ${SCHEMA}.feedback_effectiveness(analyst_used, feedback_date DESC)
  `, []);
}

async function collectTeamMetric(team) {
  const normalized = String(team || '').trim().toLowerCase();
  try {
    if (normalized === 'blog') {
      const row = await pgPool.get('blog', `
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days')::int AS posts_7d,
          COUNT(*) FILTER (WHERE status = 'published' AND created_at >= NOW() - interval '7 days')::int AS published_7d,
          COUNT(*) FILTER (WHERE status = 'ready')::int AS ready_count
        FROM blog.posts
      `, []);
      return {
        team: 'blog',
        metric_type: 'content_ops',
        posts_7d: Number(row?.posts_7d || 0),
        published_7d: Number(row?.published_7d || 0),
        ready_count: Number(row?.ready_count || 0),
      };
    }

    if (normalized === 'luna' || normalized === 'investment') {
      const [tradeRow, positionRow] = await Promise.all([
        pgPool.get('investment', `
          SELECT
            COUNT(*) FILTER (WHERE executed_at >= NOW() - interval '7 days')::int AS trades_7d,
            COALESCE(SUM(total_usdt) FILTER (WHERE executed_at >= NOW() - interval '7 days'), 0)::double precision AS traded_usdt_7d
          FROM investment.trades
        `, []),
        pgPool.get('investment', `
          SELECT COUNT(*)::int AS live_positions
          FROM investment.positions
          WHERE exchange='binance' AND paper=false AND amount > 0
        `, []),
      ]);
      return {
        team: 'luna',
        metric_type: 'trading_ops',
        trades_7d: Number(tradeRow?.trades_7d || 0),
        traded_usdt_7d: Number(tradeRow?.traded_usdt_7d || 0),
        live_positions: Number(positionRow?.live_positions || 0),
      };
    }

    if (normalized === 'darwin') {
      const row = await pgPool.get('reservation', `
        SELECT metadata
        FROM reservation.rag_research
        WHERE metadata->>'type' = 'daily_metrics'
        ORDER BY created_at DESC
        LIMIT 1
      `, []);
      return {
        team: 'darwin',
        metric_type: 'research_ops',
        total_collected: Number(row?.metadata?.total_collected || 0),
        high_relevance: Number(row?.metadata?.high_relevance || 0),
        duration_sec: Number(row?.metadata?.duration_sec || 0),
      };
    }

    const row = await pgPool.get('agent', `
      SELECT
        COUNT(*)::int AS active_agents,
        ROUND(AVG(score)::numeric, 2)::double precision AS avg_score,
        COUNT(*) FILTER (WHERE score < 5)::int AS low_score_agents
      FROM agent.registry
      WHERE team = $1
    `, [normalized]);
    return {
      team: normalized,
      metric_type: 'agent_health',
      active_agents: Number(row?.active_agents || 0),
      avg_score: Number(row?.avg_score || 0),
      low_score_agents: Number(row?.low_score_agents || 0),
    };
  } catch (error) {
    return {
      team: normalized,
      metric_type: 'unknown',
      error: error.message,
    };
  }
}

function computeEffectiveness(beforeMetric = {}, afterMetric = {}) {
  const scoreMetric = (metric) => {
    if (!metric || typeof metric !== 'object') return 0;
    if (metric.metric_type === 'content_ops') {
      return Number(metric.published_7d || 0) * 3 + Number(metric.posts_7d || 0) - Number(metric.ready_count || 0);
    }
    if (metric.metric_type === 'trading_ops') {
      return Number(metric.trades_7d || 0) * 2 + Math.min(Number(metric.traded_usdt_7d || 0) / 100, 50) + Number(metric.live_positions || 0);
    }
    if (metric.metric_type === 'research_ops') {
      return Number(metric.high_relevance || 0) * 2 + Math.max(0, 300 - Number(metric.duration_sec || 0)) / 10;
    }
    if (metric.metric_type === 'agent_health') {
      return Number(metric.active_agents || 0) + Number(metric.avg_score || 0) * 5 - Number(metric.low_score_agents || 0) * 2;
    }
    return 0;
  };

  const beforeScore = scoreMetric(beforeMetric);
  const afterScore = scoreMetric(afterMetric);
  if (beforeScore === 0 && afterScore === 0) return 0;
  if (beforeScore === 0) return Number(afterScore.toFixed(2));
  return Number((((afterScore - beforeScore) / Math.max(1, Math.abs(beforeScore))) * 100).toFixed(2));
}

async function recordDailyRun({ formation, events, report, insightCount = 0, feedbackCount = 0, meta = {} }) {
  return pgPool.get(SCHEMA, `
    INSERT INTO ${SCHEMA}.daily_runs (
      run_date, formation, events, report, insight_count, feedback_count, meta
    ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7::jsonb)
    RETURNING *
  `, [
    kst.today(),
    JSON.stringify(formation || {}),
    JSON.stringify(events || {}),
    report || '',
    Number(insightCount || 0),
    Number(feedbackCount || 0),
    JSON.stringify(meta || {}),
  ]);
}

async function recordFeedbackRecommendation({
  targetTeam,
  feedbackType,
  content,
  formation,
  analystUsed,
  beforeMetric,
}) {
  return pgPool.get(SCHEMA, `
    INSERT INTO ${SCHEMA}.feedback_effectiveness (
      target_team, feedback_type, content, formation, analyst_used, before_metric
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
    RETURNING *
  `, [
    String(targetTeam || ''),
    String(feedbackType || 'generic'),
    content || '',
    JSON.stringify(formation || {}),
    analystUsed || null,
    JSON.stringify(beforeMetric || {}),
  ]);
}

async function measurePastFeedbackEffectiveness() {
  const rows = await pgPool.query(SCHEMA, `
    SELECT *
    FROM ${SCHEMA}.feedback_effectiveness
    WHERE measured = false
      AND feedback_date < NOW() - interval '7 days'
    ORDER BY feedback_date ASC
    LIMIT 50
  `, []);

  const measured = [];
  for (const row of rows) {
    const afterMetric = await collectTeamMetric(row.target_team);
    const effectiveness = computeEffectiveness(row.before_metric || {}, afterMetric);
    const effective = effectiveness > 0;
    const updated = await pgPool.get(SCHEMA, `
      UPDATE ${SCHEMA}.feedback_effectiveness
      SET after_metric = $2::jsonb,
          effectiveness = $3,
          effective = $4,
          measured = true,
          measured_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [row.id, JSON.stringify(afterMetric), effectiveness, effective]);
    measured.push(updated);
  }

  return measured;
}

async function weeklyMetaReview() {
  const rows = await pgPool.query(SCHEMA, `
    SELECT
      analyst_used,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE effective IS TRUE)::int AS effective_count,
      ROUND(AVG(COALESCE(effectiveness, 0))::numeric, 2)::double precision AS avg_effect
    FROM ${SCHEMA}.feedback_effectiveness
    WHERE measured = true
      AND feedback_date > NOW() - interval '7 days'
    GROUP BY analyst_used
    ORDER BY avg_effect DESC NULLS LAST, total DESC
  `, []);

  if (!rows.length) {
    return { ok: true, skipped: true, message: '시그마 주간 메타리뷰 데이터 부족' };
  }

  const lines = [
    '🦉 시그마 주간 자기 평가',
    `- 기준 주간: ${kst.today()} 이전 7일`,
  ];
  rows.forEach((row) => {
    lines.push(`- ${row.analyst_used || 'unknown'}: 효과 ${row.effective_count}/${row.total}, 평균 ${row.avg_effect}`);
  });

  const result = await postAlarm({
    message: lines.join('\n'),
    team: 'sigma',
    alertLevel: 2,
    fromBot: 'sigma',
  });

  try {
    await rag.initSchema();
    await rag.store('experience', lines.join('\n'), {
      type: 'sigma_meta_review',
      period: '7d',
      rows,
    }, 'sigma');
  } catch (error) {
    console.warn(`[sigma-feedback] 메타리뷰 RAG 저장 실패: ${error.message}`);
  }

  return { ok: true, sent: result?.ok === true, rows };
}

module.exports = {
  ensureSigmaTables,
  collectTeamMetric,
  computeEffectiveness,
  recordDailyRun,
  recordFeedbackRecommendation,
  measurePastFeedbackEffectiveness,
  weeklyMetaReview,
};
