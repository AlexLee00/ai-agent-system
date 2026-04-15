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
    plannerE2EOk: Boolean(parts.plannerE2E?.payload?.ok),
    decisionSuiteOk: Boolean(parts.decisionSuite?.payload?.ok),
    decisionReportOk: Boolean(parts.decisionReport?.payload?.ok),
    decisionPassed: Number(parts.decisionSuite?.payload?.summary?.passed || 0),
    decisionFailed: Number(parts.decisionSuite?.payload?.summary?.failed || 0),
    plannerSessionCount: Number(parts.plannerE2E?.payload?.summary?.plannerSessionCount || 0),
  };
}

function render(summary) {
  return [
    `Decision E2E scenario`,
    `plannerE2E: ${summary.plannerE2EOk ? 'ok' : 'failed'}`,
    `decisionSuite: ${summary.decisionSuiteOk ? 'ok' : 'failed'}`,
    `decisionReport: ${summary.decisionReportOk ? 'ok' : 'failed'}`,
    `decisionPassed: ${summary.decisionPassed}`,
    `decisionFailed: ${summary.decisionFailed}`,
    `plannerSessions: ${summary.plannerSessionCount}`,
  ].join('\n');
}

async function main() {
  const plannerE2E = runJson('./planner-e2e-scenario.ts');
  const decisionSuite = runJson('./decision-planner-suite.ts');
  const decisionReport = runJson('./decision-planner-report.ts');

  const summary = buildSummary({ plannerE2E, decisionSuite, decisionReport });
  const ok = summary.plannerE2EOk && summary.decisionSuiteOk && summary.decisionReportOk;
  const payload = {
    ok,
    summary,
    plannerE2E: plannerE2E.payload,
    decisionSuite: decisionSuite.payload,
    decisionReport: decisionReport.payload,
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
  else console.error(`decision-e2e-scenario failed: ${payload.error}`);
  process.exitCode = 1;
});
