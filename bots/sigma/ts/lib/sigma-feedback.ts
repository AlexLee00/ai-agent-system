const pgPool = require('../../../../packages/core/lib/pg-pool') as {
  run: (schema: string, sql: string, params?: any[]) => Promise<any>;
  get: (schema: string, sql: string, params?: any[]) => Promise<any>;
  query: (schema: string, sql: string, params?: any[]) => Promise<any[]>;
};
const rag = require('../../../../packages/core/lib/rag') as {
  initSchema: () => Promise<void>;
  store: (kind: string, content: string, metadata: Record<string, any>, scope: string) => Promise<void>;
};
const { publishToRag } = require('../../../../packages/core/lib/reporting-hub') as {
  publishToRag: (payload: Record<string, any>) => Promise<{ id?: unknown }>;
};
const kst = require('../../../../packages/core/lib/kst') as { today: () => string };
const { publishToWebhook } = require('../../../../packages/core/lib/reporting-hub') as {
  publishToWebhook: (payload: { event: { from_bot: string; team: string; event_type: string; alert_level: number; message: string } }) => Promise<{ ok?: boolean }>;
};
const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory') as {
  createAgentMemory: (opts: { agentId: string; team: string }) => {
    recall: (
      query: string,
      opts?: {
        type?: 'episodic' | 'semantic' | 'procedural';
        limit?: number;
        threshold?: number | null;
      },
    ) => Promise<Array<Record<string, any>>>;
    recallHint: (
      query: string,
      opts?: Record<string, any>,
    ) => Promise<string>;
    consolidate: (opts?: Record<string, any>) => Promise<Record<string, any>>;
    remember: (content: string, type: 'episodic' | 'semantic' | 'procedural', opts?: Record<string, any>) => Promise<number | null>;
  };
};
const eventLake = require('../../../../packages/core/lib/event-lake') as {
  initSchema: () => Promise<void>;
  search: (payload: Record<string, any>) => Promise<any[]>;
  record: (payload: Record<string, any>) => Promise<any>;
};
const { pathToFileURL } = require('url') as typeof import('node:url');

const SCHEMA = 'sigma';

export async function ensureSigmaTables(): Promise<void> {
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

export async function collectTeamMetric(team: string): Promise<Record<string, any>> {
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
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function computeEffectiveness(beforeMetric: Record<string, any> = {}, afterMetric: Record<string, any> = {}): number {
  const scoreMetric = (metric: Record<string, any>): number => {
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

export async function recordDailyRun({ formation, events, report, insightCount = 0, feedbackCount = 0, meta = {} }: Record<string, any>): Promise<any> {
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

export async function recordFeedbackRecommendation({
  targetTeam,
  feedbackType,
  content,
  formation,
  analystUsed,
  beforeMetric,
}: Record<string, any>): Promise<any> {
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

export async function measurePastFeedbackEffectiveness(): Promise<any[]> {
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

export async function weeklyMetaReview(): Promise<Record<string, any>> {
  const sigmaMemory = createAgentMemory({ agentId: 'sigma.analyst', team: 'sigma' });
  const recentSemanticMemories = await sigmaMemory.recall(
    'sigma weekly meta review consolidated pattern',
    {
      type: 'semantic',
      limit: 5,
      threshold: 0.28,
    },
  ).catch(() => []);
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

  const semanticHint = await sigmaMemory.recallHint(
    'sigma weekly meta review consolidated pattern',
    {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴 참고',
      separator: 'newline',
    },
  ).catch(() => '');

  const lines = [
    '🦉 시그마 주간 자기 평가',
    `- 기준 주간: ${kst.today()} 이전 7일`,
  ];
  rows.forEach((row) => {
    lines.push(`- ${row.analyst_used || 'unknown'}: 효과 ${row.effective_count}/${row.total}, 평균 ${row.avg_effect}`);
  });
  const result = await publishToWebhook({
    event: {
      from_bot: 'sigma',
      team: 'sigma',
      event_type: 'sigma_weekly_meta_review',
      alert_level: 2,
      message: lines.join('\n') + semanticHint,
    },
  });

  try {
    await rag.initSchema();
    await publishToRag({
      ragStore: {
        async store(collection: string, ragContent: string, metadata: Record<string, any> = {}, sourceBot = 'sigma') {
          return rag.store(collection, ragContent, metadata, sourceBot);
        },
      },
      collection: 'experience',
      sourceBot: 'sigma',
      event: {
        from_bot: 'sigma',
        team: 'sigma',
        event_type: 'sigma_meta_review_rag',
        alert_level: 1,
        message: lines.join('\n'),
        payload: {
          title: '시그마 주간 메타 리뷰',
          summary: `${rows.length}건 분석`,
          details: rows.map((row) => `${row.analyst_used || 'unknown'}: ${row.effective_count}/${row.total}, 평균 ${row.avg_effect}`),
        },
      },
      metadata: {
        type: 'sigma_meta_review',
        period: '7d',
        rows,
        why: `주간 메타 리뷰 ${rows.length}건 분석`,
      },
      contentBuilder: () => `${lines.join('\n')}\n[이유: 주간 메타 리뷰 ${rows.length}건 분석]`,
      policy: {
        dedupe: true,
        key: `sigma-meta-review:${kst.today()}`,
        cooldownMs: 24 * 60 * 60 * 1000,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-feedback] 메타리뷰 RAG 저장 실패: ${message}`);
  }

  try {
    await sigmaMemory.remember(lines.join('\n'), 'episodic', {
      keywords: ['sigma', 'weekly', 'meta-review'],
      importance: rows.length >= 3 ? 0.74 : 0.64,
      expiresIn: 30 * 24 * 60 * 60,
      metadata: {
        type: 'sigma_meta_review',
        period: '7d',
        analystCount: rows.length,
        rows,
        semanticPatternCount: recentSemanticMemories.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-feedback] agent memory 저장 실패: ${message}`);
  }

  try {
    await sigmaMemory.consolidate({
      olderThanDays: 14,
      limit: 8,
      sourceType: 'episodic',
      targetType: 'semantic',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-feedback] agent memory 통합 실패: ${message}`);
  }

  return { ok: true, sent: result?.ok === true, rows, semanticPatternCount: recentSemanticMemories.length };
}

export async function collectScoutQualityMetric({ minutes = 24 * 60 }: { minutes?: number } = {}): Promise<Record<string, any>> {
  await eventLake.initSchema();
  const rows = await eventLake.search({
    team: 'luna',
    botName: 'scout',
    minutes,
    limit: 50,
  });

  const collectRows = rows.filter((row) => row.event_type === 'scout_collect');
  const errorRows = rows.filter((row) => row.event_type === 'scout_error');
  const latestCollect = collectRows[0] || null;
  const evaluationMinAgeMs = 30 * 60 * 1000;
  const latestEvaluableCollect = collectRows.find((row) => {
    const createdAt = row?.created_at ? new Date(row.created_at).getTime() : 0;
    return createdAt > 0 && (Date.now() - createdAt) >= evaluationMinAgeMs;
  }) || null;
  const sectionCounts = latestCollect?.metadata?.sectionCounts || {};
  const baselineQuotes = latestEvaluableCollect?.metadata?.baselineQuotes || {};
  const activeSectionTypes = Object.entries(sectionCounts)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([key]) => key);
  const coverageScore = activeSectionTypes.length;
  const collectCount = collectRows.length;
  const errorCount = errorRows.length;
  const totalRuns = collectCount + errorCount;
  const errorRate = totalRuns > 0 ? Number((errorCount / totalRuns).toFixed(4)) : 0;
  const quoteReturns = [];

  if (latestEvaluableCollect && baselineQuotes && typeof baselineQuotes === 'object') {
    try {
      const kis = await import(pathToFileURL(require.resolve('../../../investment/shared/kis-client.js')).href);
      const secrets = await import(pathToFileURL(require.resolve('../../../investment/shared/secrets.js')).href);
      const paper = secrets.isKisPaper();

      for (const [symbol, info] of Object.entries(baselineQuotes)) {
        const baselinePrice = Number((info as any)?.price || 0);
        if (!baselinePrice) continue;
        try {
          const currentPrice = Number(await kis.getDomesticPrice(symbol, paper));
          if (!currentPrice) continue;
          const returnPct = Number((((currentPrice - baselinePrice) / baselinePrice) * 100).toFixed(2));
          quoteReturns.push({ symbol, baselinePrice, currentPrice, returnPct });
        } catch {
        }
      }
    } catch {
    }
  }

  const avgReturnPct = quoteReturns.length > 0
    ? Number((quoteReturns.reduce((sum, item) => sum + Number(item.returnPct || 0), 0) / quoteReturns.length).toFixed(2))
    : null;
  const hitRate = quoteReturns.length > 0
    ? Number((quoteReturns.filter((item) => Number(item.returnPct || 0) > 0).length / quoteReturns.length).toFixed(4))
    : null;

  return {
    team: 'luna',
    metric_type: 'scout_quality',
    window_minutes: minutes,
    collect_count: collectCount,
    error_count: errorCount,
    total_runs: totalRuns,
    error_rate: errorRate,
    latest_focus_symbols: Array.isArray(latestCollect?.metadata?.focusSymbols)
      ? latestCollect.metadata.focusSymbols.slice(0, 5)
      : [],
    latest_overlap_symbols: Array.isArray(latestCollect?.metadata?.overlapSymbols)
      ? latestCollect.metadata.overlapSymbols.slice(0, 5)
      : [],
    latest_signal_count: Number(latestCollect?.metadata?.signalCount || 0),
    latest_sections: sectionCounts,
    coverage_score: coverageScore,
    evaluated_quotes: quoteReturns.length,
    avg_return_pct: avgReturnPct,
    hit_rate: hitRate,
    quote_returns: quoteReturns.slice(0, 10),
    evaluation_pending: !latestEvaluableCollect && collectCount > 0,
    evaluation_min_age_minutes: 30,
  };
}

export async function recordScoutQualityEvent(metric: Record<string, any> = {}): Promise<any> {
  if (!metric || typeof metric !== 'object') return null;
  const title = `스카우트 품질 요약: 수집 ${Number(metric.collect_count || 0)}회, 에러 ${Number(metric.error_count || 0)}회`;
  const message = [
    title,
    `최근 시그널: ${Number(metric.latest_signal_count || 0)}건`,
    `활성 섹션: ${Object.entries(metric.latest_sections || {}).filter(([, count]) => Number(count || 0) > 0).map(([key]) => key).join(', ') || '없음'}`,
    `집중 심볼: ${(metric.latest_focus_symbols || []).join(', ') || '없음'}`,
    metric.evaluated_quotes
      ? `평균 수익률: ${metric.avg_return_pct}% / 적중률: ${Number(metric.hit_rate || 0) * 100}%`
      : metric.evaluation_pending
        ? `가격 성과 평가는 ${Number(metric.evaluation_min_age_minutes || 30)}분 이후부터 계산`
        : '가격 성과 평가는 아직 데이터 부족',
  ].join(' | ');
  return eventLake.record({
    eventType: 'scout_quality',
    team: 'sigma',
    botName: 'sigma',
    severity: Number(metric.error_count || 0) > 0 ? 'warn' : 'info',
    title,
    message,
    tags: [
      'sigma',
      'scout',
      'source:tossinvest',
      `errors:${Number(metric.error_count || 0)}`,
      Number(metric.error_count || 0) > 0 ? 'quality:degraded' : 'quality:healthy',
    ],
    metadata: metric,
  });
}
