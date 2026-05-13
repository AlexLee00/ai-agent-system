#!/usr/bin/env tsx

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const guidePath = path.join(repoRoot, 'docs', 'hub', 'EXTERNAL_LLM_INTEGRATION_GUIDE.md');
const requestContextPath = path.join(repoRoot, 'bots', 'hub', 'src', 'middleware', 'request-context.ts');
const routeRegistryPath = path.join(repoRoot, 'bots', 'hub', 'src', 'route-registry.ts');
const llmRoutePath = path.join(repoRoot, 'bots', 'hub', 'lib', 'routes', 'llm.ts');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const guide = read(guidePath);
const requestContext = read(requestContextPath);
const routeRegistry = read(routeRegistryPath);
const llmRoute = read(llmRoutePath);

for (const required of [
  'POST /hub/llm/call',
  'POST /hub/llm/jobs',
  'GET /hub/llm/jobs/:id/result',
  'Authorization: Bearer <HUB_AUTH_TOKEN>',
  'X-Hub-Team',
  'X-Hub-Agent',
  'X-Hub-Priority',
  'callerTeam',
  'agent',
  'taskType',
  'selectorKey',
  'maxBudgetUsd',
  'hub.llm_request_log',
  'direct provider endpoint',
  'Node.js 최소 클라이언트',
  'Python 최소 클라이언트',
]) {
  assert(guide.includes(required), `external guide missing required contract text: ${required}`);
}

assert(
  guide.includes('provider API key') && guide.includes('OAuth token'),
  'external guide must prohibit provider secret distribution',
);
assert(
  routeRegistry.includes("app.use('/hub', authMiddleware)") &&
    routeRegistry.indexOf("app.use('/hub', authMiddleware)") < routeRegistry.indexOf("app.post('/hub/llm/call'"),
  'Hub auth middleware must protect /hub/llm/call',
);
assert(llmRoute.includes('direct_llm_provider_route_disabled'), 'direct provider routes must remain disabled by default');
assert(requestContext.includes('x-hub-team'), 'request context must accept X-Hub-Team alias');
assert(requestContext.includes('x-hub-agent'), 'request context must accept X-Hub-Agent alias');
assert(requestContext.includes('x-hub-priority'), 'request context must accept X-Hub-Priority alias');
assert(requestContext.includes('x-hub-trace-id'), 'request context must accept X-Hub-Trace-Id alias');

console.log(JSON.stringify({
  ok: true,
  guide: guidePath,
  contracts: {
    sync_call: '/hub/llm/call',
    async_job: '/hub/llm/jobs',
    auth: 'Bearer HUB_AUTH_TOKEN',
    external_headers: ['X-Hub-Team', 'X-Hub-Agent', 'X-Hub-Priority', 'X-Hub-Trace-Id'],
    observability: 'hub.llm_request_log',
    direct_provider_routes: 'disabled_by_default',
  },
}, null, 2));
