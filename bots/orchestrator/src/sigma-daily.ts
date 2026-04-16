
const rag = require('../../../packages/core/lib/rag') as {
  initSchema: () => Promise<void>;
  store: (kind: string, content: string, metadata: Record<string, any>, scope: string) => Promise<void>;
};
const { publishToRag } = require('../../../packages/core/lib/reporting-hub') as {
  publishToRag: (payload: Record<string, any>) => Promise<{ id?: unknown }>;
};
const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub') as {
  publishToWebhook: (payload: { event: { from_bot: string; team: string; event_type: string; alert_level: number; message: string } }) => Promise<{ ok?: boolean }>;
};
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory') as {
  createAgentMemory: (opts: { agentId: string; team: string }) => {
    remember: (content: string, type: 'episodic' | 'semantic' | 'procedural', opts?: Record<string, any>) => Promise<number | null>;
    recall: (query: string, opts?: Record<string, any>) => Promise<Array<Record<string, any>>>;
    consolidate: (opts?: Record<string, any>) => Promise<{ scanned: number; created: number; sourceIds: number[]; memoryId: number | null }>;
  };
};
const kst = require('../../../packages/core/lib/kst') as { today: () => string };

const { decideTodayFormation } = require('../lib/sigma/sigma-scheduler') as {
  decideTodayFormation: (opts?: Record<string, any>) => Promise<any>;
};
const { analyzeFormation } = require('../lib/sigma/sigma-analyzer') as {
  analyzeFormation: (formation: any) => Promise<any>;
};
const {
  ensureSigmaTables,
  collectScoutQualityMetric,
  recordDailyRun,
  recordScoutQualityEvent,
  recordFeedbackRecommendation,
  measurePastFeedbackEffectiveness,
  weeklyMetaReview,
} = require('../lib/sigma/sigma-feedback') as {
  ensureSigmaTables: () => Promise<void>;
  collectScoutQualityMetric: () => Promise<any>;
  recordDailyRun: (payload: Record<string, any>) => Promise<any>;
  recordScoutQualityEvent: (payload: any) => Promise<void>;
  recordFeedbackRecommendation: (payload: Record<string, any>) => Promise<any>;
  measurePastFeedbackEffectiveness: () => Promise<any[]>;
  weeklyMetaReview: () => Promise<any>;
};

type SigmaDailyOptions = {
  test?: boolean;
};

function parseArgs(argv: string[] = process.argv.slice(2)): SigmaDailyOptions {
  return {
    test: argv.includes('--test'),
  };
}

export async function runDaily({ test = false }: SigmaDailyOptions = {}): Promise<Record<string, any>> {
  await ensureSigmaTables();
  const sigmaMemory = createAgentMemory({ agentId: 'sigma.analyst', team: 'sigma' });
  const measured = await measurePastFeedbackEffectiveness();
  const scoutQuality = await collectScoutQualityMetric();
  const decisionMemories = await sigmaMemory.recall(
    'sigma daily report weekly meta-review',
    {
      type: 'episodic',
      limit: 5,
      threshold: 0.3,
    },
  ).catch(() => []);
  const semanticDecisionMemories = await sigmaMemory.recall(
    'sigma daily report weekly meta-review consolidated pattern',
    {
      type: 'semantic',
      limit: 3,
      threshold: 0.3,
    },
  ).catch(() => []);
  const formation = await decideTodayFormation({
    recentMemories: decisionMemories,
    recentSemanticMemories: semanticDecisionMemories,
  });
  const recentMemories = await sigmaMemory.recall(
    [
      formation.formationReason || '',
      ...(formation.targetTeams || []),
      ...(formation.analysts || []),
      'sigma daily report',
    ].filter(Boolean).join(' '),
    {
      type: 'episodic',
      limit: 3,
      threshold: 0.35,
    },
  ).catch(() => []);
  const analysis = await analyzeFormation(formation, { recentMemories });

  const feedbackRows = [];
  for (const feedback of analysis.feedbacks || []) {
    const row = await recordFeedbackRecommendation({
      ...feedback,
      formation,
    });
    feedbackRows.push(row);
  }

  const dailyRun = await recordDailyRun({
    formation,
    events: formation.events,
    report: analysis.report,
    insightCount: analysis.insightCount,
    feedbackCount: feedbackRows.length,
    meta: {
      measuredCount: measured.length,
      teams: formation.targetTeams,
      analysts: formation.analysts,
      scoutQuality,
      decisionMemoryCount: decisionMemories.length,
      semanticDecisionMemoryCount: semanticDecisionMemories.length,
      recentMemoryCount: recentMemories.length,
    },
  });

  await recordScoutQualityEvent(scoutQuality);

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
        event_type: 'sigma_daily_rag',
        alert_level: 1,
        message: analysis.report,
        payload: {
          title: '시그마 일일 크로스팀 분석',
          summary: `${feedbackRows.length}건 피드백 생성`,
          details: [
            `teams: ${(formation.targetTeams || []).join(', ')}`,
            `analysts: ${(formation.analysts || []).join(', ')}`,
          ],
        },
      },
      metadata: {
        type: 'sigma_daily_report',
        date: kst.today(),
        teams: formation.targetTeams,
        analysts: formation.analysts,
        feedback_count: feedbackRows.length,
        scout_quality: scoutQuality,
        decision_memory_count: decisionMemories.length,
        semantic_decision_memory_count: semanticDecisionMemories.length,
        recent_memory_count: recentMemories.length,
        why: `일일 크로스팀 분석 ${feedbackRows.length}건 피드백 생성`,
      },
      contentBuilder: () => `${analysis.report}\n[이유: 일일 크로스팀 분석 ${feedbackRows.length}건 피드백 생성]`,
      policy: {
        dedupe: true,
        key: `sigma-daily-rag:${kst.today()}`,
        cooldownMs: 12 * 60 * 60 * 1000,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-daily] RAG 저장 실패: ${message}`);
  }

  try {
    await sigmaMemory.remember(analysis.report, 'episodic', {
      keywords: [
        'sigma',
        'daily',
        ...(formation.targetTeams || []).map((team: string) => String(team)),
      ].slice(0, 8),
      importance: feedbackRows.length > 0 ? 0.72 : 0.58,
      expiresIn: 30 * 24 * 60 * 60,
      metadata: {
        type: 'sigma_daily_report',
        date: kst.today(),
        targetTeams: formation.targetTeams || [],
        analysts: formation.analysts || [],
        feedbackCount: feedbackRows.length,
        measuredCount: measured.length,
        scoutQuality,
        decisionMemoryCount: decisionMemories.length,
        semanticDecisionMemoryCount: semanticDecisionMemories.length,
        recentMemoryCount: recentMemories.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-daily] agent memory 저장 실패: ${message}`);
  }

  let consolidation = { scanned: 0, created: 0, sourceIds: [], memoryId: null as number | null };
  try {
    consolidation = await sigmaMemory.consolidate({
      olderThanDays: 14,
      limit: 12,
      sourceType: 'episodic',
      targetType: 'semantic',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-daily] agent memory 통합 실패: ${message}`);
  }

  let metaReview = null;
  if (new Date().getDay() === 5) {
    metaReview = await weeklyMetaReview();
  }

  if (!test) {
    await publishToWebhook({
      event: {
        from_bot: 'sigma',
        team: 'sigma',
        event_type: 'sigma_daily_report',
        alert_level: 2,
        message: analysis.report,
      },
    });
  }

  return {
    ok: true,
    formation,
    measuredCount: measured.length,
    dailyRunId: dailyRun?.id || null,
    feedbackCount: feedbackRows.length,
    semanticDecisionMemoryCount: semanticDecisionMemories.length,
    consolidation,
    metaReview: metaReview ? { sent: !!metaReview.sent, skipped: !!metaReview.skipped } : null,
    message: analysis.report,
  };
}

if (require.main === module) {
  const args = parseArgs();
  runDaily(args)
    .then((result) => {
      console.log(JSON.stringify({
        ok: result.ok,
        date: result.formation?.date,
        targetTeams: result.formation?.targetTeams,
        analysts: result.formation?.analysts,
        feedbackCount: result.feedbackCount,
        measuredCount: result.measuredCount,
        dailyRunId: result.dailyRunId,
      }, null, 2));
      console.log('\n' + result.message);
      process.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`[sigma-daily] 실행 실패: ${message}`);
      process.exit(1);
    });
}
