// @ts-nocheck
'use strict';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function run(input = {}) {
  const routes = toArray(input.routes);
  const healthyRoutes = routes.filter((item) => item && item.ok);
  const assertions = [
    {
      key: 'build_ok',
      ok: Boolean(input.buildOk),
    },
    {
      key: 'restart_ok',
      ok: Boolean(input.restarted),
    },
    {
      key: 'health_ok',
      ok: Boolean(input.health?.ok),
    },
    {
      key: 'critical_route_ok',
      ok: healthyRoutes.length > 0,
      value: healthyRoutes.length,
    },
  ];

  const failures = assertions.filter((item) => !item.ok).map((item) => item.key);
  const evidence = [
    `scope=${input.scope || 'unknown'}`,
    `routes=${routes.length}`,
    `healthy_routes=${healthyRoutes.length}`,
    `health=${input.health?.ok ? 'ok' : 'fail'}`,
  ];

  const nextActions = [];
  if (!assertions[0].ok) nextActions.push('Fix build before shipping.');
  if (!assertions[1].ok) nextActions.push('Restart target services and confirm clean process state.');
  if (!assertions[2].ok) nextActions.push('Run health checks again until the target service is green.');
  if (!assertions[3].ok) nextActions.push('Confirm at least one critical route after restart.');
  if (!failures.length) nextActions.push('Ship checklist complete; monitor post-release logs and health.');

  const finalVerdict = failures.length ? 'fail' : 'pass';

  return {
    workflow: 'ship-workflow',
    inputs: {
      scope: input.scope || null,
      buildOk: Boolean(input.buildOk),
      restarted: Boolean(input.restarted),
      health: input.health || null,
      routes,
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
