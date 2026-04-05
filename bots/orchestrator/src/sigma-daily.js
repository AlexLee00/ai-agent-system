#!/usr/bin/env node
'use strict';

const rag = require('../../../packages/core/lib/rag');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');
const kst = require('../../../packages/core/lib/kst');

const { decideTodayFormation } = require('../lib/sigma/sigma-scheduler');
const { analyzeFormation } = require('../lib/sigma/sigma-analyzer');
const {
  ensureSigmaTables,
  recordDailyRun,
  recordFeedbackRecommendation,
  measurePastFeedbackEffectiveness,
  weeklyMetaReview,
} = require('../lib/sigma/sigma-feedback');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    test: argv.includes('--test'),
  };
}

async function runDaily({ test = false } = {}) {
  await ensureSigmaTables();
  const measured = await measurePastFeedbackEffectiveness();
  const formation = await decideTodayFormation();
  const analysis = await analyzeFormation(formation);

  const feedbackRows = [];
  for (const feedback of analysis.feedbacks) {
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
    },
  });

  try {
    await rag.initSchema();
    await rag.store('experience', analysis.report, {
      type: 'sigma_daily_report',
      date: kst.today(),
      teams: formation.targetTeams,
      analysts: formation.analysts,
      feedback_count: feedbackRows.length,
    }, 'sigma');
  } catch (error) {
    console.warn(`[sigma-daily] RAG 저장 실패: ${error.message}`);
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

module.exports = {
  runDaily,
};

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
      console.error(`[sigma-daily] 실행 실패: ${error?.stack || error?.message || String(error)}`);
      process.exit(1);
    });
}
