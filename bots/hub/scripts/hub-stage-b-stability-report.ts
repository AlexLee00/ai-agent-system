#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildHubStageBStabilityReport,
  writeHubStageBStabilityReport,
} = require('../lib/stage-b/stability.ts');

const args = new Set(process.argv.slice(2));
const hasFlag = (flag) => args.has(flag);
const getArgValue = (name) => {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
};

async function main() {
  const report = await buildHubStageBStabilityReport({
    skipDb: hasFlag('--skip-db'),
    skipLaunchctl: hasFlag('--skip-launchctl'),
    hours: Number(getArgValue('--hours') || 24),
  });

  if (hasFlag('--write')) {
    report.outputPath = await writeHubStageBStabilityReport(report);
  }

  if (hasFlag('--json') || hasFlag('--write')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Hub Stage B stability: ${report.status}`);
    console.log(`selector=${report.selectorEnforcement.ok ? 'ok' : 'attention'} protected=${report.protected.running}/${report.protected.protectedCount} requestLog=${report.requestLog.ok ? 'ok' : 'attention'}`);
    if (report.selfHealing.confirmRequiredActions.length) {
      console.log(`confirm_required=${report.selfHealing.confirmRequiredActions.length}`);
    }
  }

  if (!report.selectorEnforcement.ok || !report.requestLog.ok) process.exit(1);
}

main().catch((error) => {
  console.error('[hub-stage-b-stability-report] failed:', error?.message || error);
  process.exit(1);
});
