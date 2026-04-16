// @ts-nocheck
'use strict';

const { parseArgs } = require('../../reservation/lib/args');
const {
  storeExperience,
  searchExperience,
  getIntentStats,
  getPromotionCandidates,
} = require('../../../packages/core/lib/experience-store');

async function main() {
  const args = parseArgs(process.argv);
  const limit = Number(args.limit || 5);

  if (args.store) {
    const payload = {
      userInput: args.input,
      intent: args.intent,
      response: args.response,
      result: args.result,
      team: args.team || 'general',
      sourceBot: args.sourceBot || args['source-bot'] || 'openclaw',
      details: {},
    };

    for (const [key, value] of Object.entries(args)) {
      if (['store', 'input', 'intent', 'response', 'result', 'team', 'sourceBot', 'source-bot'].includes(key)) continue;
      payload.details[key] = value;
    }

    const id = await storeExperience(payload);
    console.log(JSON.stringify({
      success: true,
      mode: 'store',
      id,
      message: '경험 저장 완료',
    }));
    return;
  }

  if (args.search) {
    const items = await searchExperience(args.query, {
      intent: args.intent || null,
      team: args.team || null,
      limit,
    });
    console.log(JSON.stringify({
      success: true,
      mode: 'search',
      count: items.length,
      items,
    }));
    return;
  }

  if (args.stats) {
    const stats = await getIntentStats(args.intent);
    console.log(JSON.stringify({
      success: true,
      mode: 'stats',
      intent: stats.intent,
      total: stats.total,
      successCount: stats.success,
      failCount: stats.fail,
      successRate: stats.successRate,
    }));
    return;
  }

  if (args.candidates) {
    const items = await getPromotionCandidates(limit);
    console.log(JSON.stringify({
      success: true,
      mode: 'candidates',
      count: items.length,
      items,
    }));
    return;
  }

  console.log(JSON.stringify({
    success: false,
    message: 'usage: --store | --search | --stats | --candidates',
  }));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
