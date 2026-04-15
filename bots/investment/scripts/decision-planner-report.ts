// @ts-nocheck
import { spawnSync } from 'child_process';

function runSuite() {
  const scriptPath = new URL('./decision-planner-suite.ts', import.meta.url).pathname;
  const child = spawnSync(process.execPath, [scriptPath, '--json'], { encoding: 'utf8' });
  const stdout = String(child.stdout || '').trim();
  const payload = stdout ? JSON.parse(stdout) : null;
  return {
    status: child.status,
    payload,
  };
}

function render(payload) {
  const summary = payload?.summary || {};
  const lines = [
    `Decision Planner ${payload?.ok ? 'OK' : 'FAILED'}`,
    `total: ${summary.total || 0}`,
    `passed: ${summary.passed || 0}`,
    `failed: ${summary.failed || 0}`,
  ];

  for (const row of payload?.results || []) {
    lines.push(
      `${row.market} | ${row.symbol} | planner=${row.plannerCompact ? 'ok' : 'missing'} | l10=${row.l10PlannerInMeta ? 'ok' : 'missing'} | l14=${row.l14PlannerInMeta ? 'ok' : 'missing'} | l21=${row.l21PlannerInMeta ? 'ok' : 'missing'} | l30=${row.l30PlannerInMeta ? 'ok' : 'missing'} | l32=${row.l32PlannerInMeta ? 'ok' : 'missing'} | l33=${row.l33PlannerInMeta ? 'ok' : 'missing'} | l34=${row.l34PlannerInMeta ? 'ok' : 'missing'}`,
    );
  }

  return lines.join('\n');
}

async function main() {
  const result = runSuite();
  const payload = result.payload || { ok: false, error: 'suite_failed' };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: Boolean(payload.ok),
      text: render(payload),
      suite: payload,
    }, null, 2));
    return;
  }

  console.log(render(payload));
}

main().catch((error) => {
  const payload = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.error(`decision-planner-report failed: ${payload.error}`);
  process.exitCode = 1;
});
