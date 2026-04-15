// @ts-nocheck
import { spawnSync } from 'child_process';

function runJson(scriptName) {
  const child = spawnSync(process.execPath, [new URL(scriptName, import.meta.url).pathname, '--json'], {
    encoding: 'utf8',
  });

  const stdout = String(child.stdout || '').trim();
  const stderr = String(child.stderr || '').trim();
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }

  return {
    ok: child.status === 0 && Boolean(parsed?.ok),
    status: child.status,
    stdout,
    stderr,
    payload: parsed,
  };
}

function buildSummary(parts) {
  return {
    sessionSuiteOk: Boolean(parts.sessionSuite?.payload?.ok),
    decisionSuiteOk: Boolean(parts.decisionSuite?.payload?.ok),
    reportOk: Boolean(parts.report?.payload?.ok),
    plannerSessionCount: Number(parts.report?.payload?.count || 0),
    plannerByMarket: parts.report?.payload?.summary?.byMarket || {},
    plannerByMode: parts.report?.payload?.summary?.byMode || {},
  };
}

function render(summary) {
  return [
    `Planner E2E scenario`,
    `sessionSuite: ${summary.sessionSuiteOk ? 'ok' : 'failed'}`,
    `decisionSuite: ${summary.decisionSuiteOk ? 'ok' : 'failed'}`,
    `report: ${summary.reportOk ? 'ok' : 'failed'}`,
    `plannerSessions: ${summary.plannerSessionCount}`,
    `byMarket: ${Object.entries(summary.plannerByMarket).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
    `byMode: ${Object.entries(summary.plannerByMode).map(([k, v]) => `${k}:${v}`).join(', ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const sessionSuite = runJson('./planner-session-suite.ts');
  const decisionSuite = runJson('./decision-planner-suite.ts');
  const report = runJson('./planner-session-report.ts');

  const summary = buildSummary({ sessionSuite, decisionSuite, report });
  const ok = summary.sessionSuiteOk && summary.decisionSuiteOk && summary.reportOk;
  const payload = {
    ok,
    summary,
    sessionSuite: sessionSuite.payload,
    decisionSuite: decisionSuite.payload,
    report: report.payload,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(render(summary));
}

main().catch((error) => {
  const payload = { ok: false, error: error?.message || String(error) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
  else console.error(`planner-e2e-scenario failed: ${payload.error}`);
  process.exitCode = 1;
});
