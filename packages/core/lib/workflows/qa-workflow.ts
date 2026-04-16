// @ts-nocheck
'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function run(input = {}) {
  const routes = toArray(input.routes);
  const checks = toArray(input.checks);
  const buildCheck = checks.find((item) => item?.name === 'build');
  const routeCheck = checks.find((item) => item?.name === 'route-200' || item?.name === 'critical-route');
  const browserCheck = checks.find((item) => item?.name === 'browser-smoke' || item?.name === 'ui-smoke');

  const assertions = [
    {
      key: 'build_ok',
      ok: buildCheck ? Boolean(buildCheck.ok) : false,
      note: buildCheck ? null : 'Build check missing.',
    },
    {
      key: 'critical_route_ok',
      ok: routeCheck ? Boolean(routeCheck.ok) : routes.length === 0,
      note: routeCheck ? null : (routes.length ? 'Critical route check missing.' : 'No critical routes declared.'),
    },
    {
      key: 'browser_or_alternative_verification',
      ok: browserCheck ? Boolean(browserCheck.ok) : checks.some((item) => /smoke|ui|manual/i.test(String(item?.name || ''))),
      note: browserCheck ? (browserCheck.note || null) : 'Browser smoke was not explicitly recorded.',
    },
  ];

  const failures = assertions.filter((item) => !item.ok).map((item) => item.key);
  const evidence = [
    `scope=${input.scope || 'unknown'}`,
    `routes=${routes.length}`,
    `checks=${checks.length}`,
  ];

  const nextActions = [];
  if (!assertions[0].ok) nextActions.push('Run and capture a successful build step.');
  if (!assertions[1].ok) nextActions.push('Verify critical routes or APIs with a 200-level smoke check.');
  if (!assertions[2].ok) nextActions.push('Capture browser smoke or equivalent UI validation evidence.');
  if (!failures.length) nextActions.push('QA baseline satisfied; proceed to ship workflow if needed.');

  let finalVerdict = 'pass';
  if (!assertions[0].ok || !assertions[1].ok) {
    finalVerdict = 'fail';
  } else if (!assertions[2].ok) {
    finalVerdict = 'warn';
  }

  return {
    workflow: 'qa-workflow',
    inputs: {
      scope: input.scope || null,
      routes,
      checks,
    },
    assertions,
    evidence,
    failures,
    finalVerdict,
    nextActions,
  };
}

module.exports = {
  run,
};
