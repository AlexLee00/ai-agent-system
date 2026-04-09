#!/usr/bin/env node

const rag = require('../../../packages/core/lib/rag') as {
  initSchema: () => Promise<void>;
  store: (kind: string, content: string, metadata: Record<string, any>, scope: string) => Promise<void>;
};
const { postAlarm } = require('../../../packages/core/lib/openclaw-client') as {
  postAlarm: (payload: { message: string; team: string; alertLevel: number; fromBot: string }) => Promise<{ ok?: boolean }>;
};
const kst = require('../../../packages/core/lib/kst') as { today: () => string };

const { decideTodayFormation } = require('../lib/sigma/sigma-scheduler') as {
  decideTodayFormation: () => Promise<any>;
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
  const measured = await measurePastFeedbackEffectiveness();
  const scoutQuality = await collectScoutQualityMetric();
  const formation = await decideTodayFormation();
  const analysis = await analyzeFormation(formation);

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
    },
  });

  await recordScoutQualityEvent(scoutQuality);

  try {
    await rag.initSchema();
    await rag.store(
      'experience',
      `${analysis.report}\n[이유: 일일 크로스팀 분석 ${feedbackRows.length}건 피드백 생성]`,
      {
        type: 'sigma_daily_report',
        date: kst.today(),
        teams: formation.targetTeams,
        analysts: formation.analysts,
        feedback_count: feedbackRows.length,
        scout_quality: scoutQuality,
        why: `일일 크로스팀 분석 ${feedbackRows.length}건 피드백 생성`,
      },
      'sigma',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sigma-daily] RAG 저장 실패: ${message}`);
  }

  let metaReview = null;
  if (new Date().getDay() === 5) {
    metaReview = await weeklyMetaReview();
  }

  if (!test) {
    await postAlarm({
      message: analysis.report,
      team: 'sigma',
      alertLevel: 2,
      fromBot: 'sigma',
    });
  }

  return {
    ok: true,
    formation,
    measuredCount: measured.length,
    dailyRunId: dailyRun?.id || null,
    feedbackCount: feedbackRows.length,
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
