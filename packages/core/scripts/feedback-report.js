'use strict';

const path = require('path');
const pgPool = require(path.join(__dirname, '../lib/pg-pool'));
const {
  getFeedbackSessionSummary,
  getFeedbackFieldStats,
  getFeedbackSessions,
} = require(path.join(__dirname, '../lib/ai-feedback-store'));
const {
  buildFeedbackSummaryLines,
} = require(path.join(__dirname, '../lib/ai-feedback-report'));

function parseArgs(argv) {
  const result = {
    schema: 'worker',
    sinceDays: 30,
    limit: 20,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--json') result.json = true;
    if (token === '--schema' && argv[i + 1]) result.schema = argv[++i];
    if (token === '--days' && argv[i + 1]) result.sinceDays = Number(argv[++i]) || 30;
    if (token === '--limit' && argv[i + 1]) result.limit = Number(argv[++i]) || 20;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [summary, fieldStats, sessions] = await Promise.all([
    getFeedbackSessionSummary(pgPool, {
      schema: args.schema,
      sinceDays: args.sinceDays,
    }),
    getFeedbackFieldStats(pgPool, {
      schema: args.schema,
      sinceDays: args.sinceDays,
      limit: args.limit,
    }),
    getFeedbackSessions(pgPool, {
      schema: args.schema,
      sinceDays: args.sinceDays,
      limit: args.limit,
    }),
  ]);

  const report = {
    schema: args.schema,
    sinceDays: args.sinceDays,
    summary,
    fieldStats,
    sessions,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(buildFeedbackSummaryLines(report));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[feedback-report] 실패:', error.message);
    process.exit(1);
  });
}

module.exports = { main };
