#!/usr/bin/env node

import { query as defaultQuery } from '../shared/db.ts';
import {
  buildLunaHybridPromotionReviewReport,
  LUNA_HYBRID_PHASE11,
} from '../shared/luna-hybrid-promotion-review.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type PromotionReviewOptions = {
  apply: boolean;
  json: boolean;
  strict: boolean;
  noDb: boolean;
  hours: number;
};
type PromotionReviewDeps = {
  queryFn?: unknown;
  investmentRoot?: string;
  projectRoot?: string;
};

function argValue(name: string, fallback: string | number | null = null, argv: string[] = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv: string[] = process.argv.slice(2)): PromotionReviewOptions {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    noDb: argv.includes('--no-db'),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
  };
}

export async function runLunaHybridPromotionReview(options: PromotionReviewOptions = parseArgs(), deps: PromotionReviewDeps = {}) {
  if (options.apply) {
    return {
      ok: false,
      phase: LUNA_HYBRID_PHASE11,
      status: 'luna_hybrid_promotion_review_apply_blocked',
      shadowMode: true,
      liveMutation: false,
      protectedPidMutation: false,
      promotionReady: false,
      masterApprovalRequired: true,
      blockers: [{
        type: 'safety',
        name: 'apply_not_supported',
        detail: 'Phase 11 is a read-only master review/runbook pack; live promotion requires a separate explicit approval path.',
      }],
    };
  }

  const queryFn = options.noDb ? null : deps.queryFn || defaultQuery;
  return buildLunaHybridPromotionReviewReport({
    queryFn,
    dataRequired: !options.noDb,
    hours: options.hours,
    investmentRoot: deps.investmentRoot,
    projectRoot: deps.projectRoot,
  });
}

async function main() {
  const options = parseArgs();
  const report = await runLunaHybridPromotionReview(options);
  if (options.strict && !report.ok) {
    process.exitCode = 1;
  }
  if (options.apply) {
    process.exitCode = 2;
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const typedReport = report as any;
  console.log(`${typedReport.status} readyForMasterReview=${typedReport.readyForMasterReview === true} promotionReady=${typedReport.promotionReady === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna hybrid promotion review failed:',
  });
}

export default { runLunaHybridPromotionReview };
