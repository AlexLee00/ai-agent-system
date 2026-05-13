#!/usr/bin/env tsx

const {
  buildHubStageCResilienceReport,
  writeHubStageCResilienceReport,
} = require('../lib/stage-c/resilience');

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const report = await buildHubStageCResilienceReport({
    skipDb: hasFlag('--skip-db'),
  });

  if (hasFlag('--write')) {
    await writeHubStageCResilienceReport(report);
  }

  if (hasFlag('--json') || hasFlag('--write')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[hub-stage-c] ${report.status}`);
    console.log(`- DRP: ${report.drp.ok ? 'ready' : 'attention'}`);
    console.log(`- security: ${report.security.ok ? 'ready' : 'attention'}`);
    console.log(`- chaos: ${report.chaos.ok ? 'ready' : 'attention'}`);
    console.log(`- external gateway: ${report.externalGateway.ok ? 'ready' : 'attention'}`);
  }

  if (!report.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
