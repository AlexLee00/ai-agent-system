#!/usr/bin/env tsx

const {
  buildChaosPlan,
  runFixtureChaosDrill,
} = require('../lib/stage-c/resilience');

function argValue(prefix: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return found ? found.slice(prefix.length + 1) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm');
  const json = hasFlag('--json');

  if (apply && confirm !== 'hub-stage-c-chaos') {
    const payload = {
      ok: false,
      error: 'confirm_required',
      requiredConfirm: 'hub-stage-c-chaos',
      liveChaosAllowed: false,
      plan: buildChaosPlan(),
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }

  if (apply) {
    const payload = {
      ok: false,
      error: 'live_chaos_not_implemented_in_codex_operator',
      reason: 'Stage C supports fixture chaos by default. k6/live provider chaos must be launched by a human operator with scoped runtime approval.',
      nextCommand: 'k6 run tests/load/chaos.js',
      plan: buildChaosPlan(),
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }

  const result = runFixtureChaosDrill();
  if (json || hasFlag('--fixture')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[hub-stage-c-chaos] fixture scenarios=${result.scenarios.length} ok=${result.ok}`);
  }
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
