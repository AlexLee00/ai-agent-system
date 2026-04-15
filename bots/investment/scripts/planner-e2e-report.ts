// @ts-nocheck
import { spawnSync } from 'child_process';

function runScenario() {
  const scriptPath = new URL('./planner-e2e-scenario.ts', import.meta.url).pathname;
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
    `Planner E2E ${payload?.ok ? 'OK' : 'FAILED'}`,
    `sessionSuite: ${summary.sessionSuiteOk ? 'ok' : 'failed'}`,
    `decisionSuite: ${summary.decisionSuiteOk ? 'ok' : 'failed'}`,
    `report: ${summary.reportOk ? 'ok' : 'failed'}`,
    `plannerSessions: ${summary.plannerSessionCount || 0}`,
    `byMarket: ${Object.entries(summary.plannerByMarket || {}).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
    `byMode: ${Object.entries(summary.plannerByMode || {}).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}

async function main() {
  const result = runScenario();
  const payload = result.payload || { ok: false, error: 'scenario_failed' };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: Boolean(payload.ok),
      text: render(payload),
      scenario: payload,
    }, null, 2));
    return;
  }

  console.log(render(payload));
}

main().catch((error) => {
  const payload = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.error(`planner-e2e-report failed: ${payload.error}`);
  process.exitCode = 1;
});
