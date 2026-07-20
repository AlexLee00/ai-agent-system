#!/usr/bin/env tsx

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const guidePath = path.join(repoRoot, 'docs', 'hub', 'EXTERNAL_LLM_INTEGRATION_GUIDE.md');
const onboardingPath = path.join(repoRoot, 'docs', 'hub', 'EXTERNAL_LLM_GATEWAY_PROJECT_ONBOARDING.md');
const internalGuidePath = path.join(repoRoot, 'bots', 'hub', 'docs', 'LLM_ROUTING.md');
const codingGuidePath = path.join(repoRoot, 'docs', 'guides', 'coding.md');
const oauthGuidePath = path.join(repoRoot, 'docs', 'hub', 'OAUTH_REAUTH_GUIDE.md');
const stageCOperationsPath = path.join(repoRoot, 'docs', 'hub', 'HUB_STAGE_C_OPERATIONS.md');
const hubPackagePath = path.join(repoRoot, 'bots', 'hub', 'package.json');
const requestContextPath = path.join(repoRoot, 'bots', 'hub', 'src', 'middleware', 'request-context.ts');
const routeRegistryPath = path.join(repoRoot, 'bots', 'hub', 'src', 'route-registry.ts');
const llmRoutePath = path.join(repoRoot, 'bots', 'hub', 'lib', 'routes', 'llm.ts');
const investmentHubClientPath = path.join(repoRoot, 'bots', 'investment', 'shared', 'hub-llm-client.ts');
const modelSelectorPath = path.join(repoRoot, 'packages', 'core', 'lib', 'llm-model-selector.ts');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

const guide = read(guidePath);
const onboarding = read(onboardingPath);
const internalGuide = read(internalGuidePath);
const oauthGuide = read(oauthGuidePath);
const codingGuide = read(codingGuidePath);
const hubPackage = JSON.parse(read(hubPackagePath));
const requestContext = read(requestContextPath);
const routeRegistry = read(routeRegistryPath);
const llmRoute = read(llmRoutePath);
const investmentHubClient = read(investmentHubClientPath);
const { selectLLMChain } = require(modelSelectorPath);

for (const required of [
  'POST /hub/llm/call',
  'POST /hub/llm/jobs',
  'GET /hub/llm/jobs?limit=<1..100>',
  'POST /hub/llm/vision',
  'POST /hub/llm/embeddings',
  'GET /hub/llm/jobs/:id/result',
  'GET /hub/llm/gateway-contract',
  'contractRevision',
  'contextSources',
  'requestSchemas',
  'requiredContext',
  'oneOfBody',
  'Authorization: Bearer <HUB_AUTH_TOKEN>',
  '신뢰하지 않는 tenant',
  'X-Hub-Team',
  'X-Hub-Agent',
  'X-Hub-Priority',
  'callerTeam',
  'agent',
  'runtimePurpose',
  'taskType',
  'selectorKey',
  'maxBudgetUsd',
  'hub.llm_request_log',
  'direct provider endpoint',
  'Node.js 최소 클라이언트',
  'Python 최소 클라이언트',
  'Vision/Embedding 호출',
  'Stage C 운영 계약',
  '현재 운영 기준',
  'HUB_LLM_GEMINI_DISABLED',
  'gemini_provider_disabled',
  'code_change_only',
  'declaration_only',
  'team:agent-llm-drill:live',
  'upstreamStatus',
  'retryAfterMs',
  'providerBackpressure',
  'limiterBackpressure',
  'admissionScope',
  'llm_total_deadline_exceeded',
  'provider_termination_unconfirmed',
  'docs/hub/OAUTH_REAUTH_GUIDE.md',
  'docs/hub/HUB_STAGE_C_OPERATIONS.md',
  'payload.ok !== true',
  'payload.get("ok") is not True',
  'Array.isArray(decoded)',
  'isinstance(payload, dict)',
]) {
  assert(guide.includes(required), `external guide missing required contract text: ${required}`);
}

for (const required of [
  'callHubLlm',
  'callHubVision',
  'callHubEmbedding',
  'HubCallError',
  'isHubNoDirectFallbackFailure',
  'runtimePurpose',
  'static_unregistered_purpose_selectors',
  'perAttemptTimeoutMs',
  'upstreamStatus',
  'retryAfterMs',
  'limiterBackpressure',
  'admissionRejections',
  'provider_termination_unconfirmed',
  '직접 fallback',
  '같은 job ID',
  'tenant 인증',
  'callerTeam_required',
  'callerTeam_mismatch',
  'llm_job_not_found',
  'GET /hub/llm/gateway-contract',
  'contractRevision',
  'contextSources',
  'requiredContext',
  'oneOfBody',
  'code_change_only',
]) {
  assert(internalGuide.includes(required), `internal guide missing required contract text: ${required}`);
}

for (const required of [
  'runtimePurpose',
  'abstractModel',
  'timeoutMs',
  'retryAfterMs',
  'providerBackpressure',
  'limiterBackpressure',
  'admissionScope',
  'same job ID',
  'direct provider fallback',
  'X-Hub-Team',
  'cross-team reads return `404`',
  'contractRevision',
  'contextSources',
  'requiredContext',
  'oneOfBody',
  'code_change_only',
]) {
  assert(onboarding.includes(required), `external onboarding missing required contract text: ${required}`);
}

assert(!guide.includes('"selectorKey": "darwin.research"'), 'external guide must not reference an unregistered Darwin selector');
assert(!guide.includes('실제 provider 재활성화는 Hub 운영 담당의 별도 승인 후 진행한다'), 'external guide must not imply env/operator reactivation of retired Gemini');
assert(oauthGuide.includes('gemini_provider_disabled'), 'OAuth guide must document Gemini retirement');
assert(!oauthGuide.includes('/hub/oauth/gemini/start'), 'OAuth guide must not advertise a retired Gemini login endpoint');
assert(guide.includes('"selectorKey": "darwin.agent_policy"'), 'external async example must use the registered Darwin policy selector');
for (const documentedPath of [oauthGuidePath, stageCOperationsPath]) {
  assert(fs.existsSync(documentedPath), `documented Hub guide path must exist: ${documentedPath}`);
}
for (const script of [
  'llm:external-gateway-contract-smoke',
  'check:llm-stage-c',
  'team:agent-llm-drill:live',
  'llm:gemini-residue-audit',
]) {
  assert(hubPackage?.scripts?.[script], `documented Hub npm script must exist: ${script}`);
}
for (const selectorKey of [
  'blog.commenter.classify',
  'blog.star.summarize',
  'blog.pos.writer',
  'darwin.agent_policy',
  'hub._default',
  'investment.agent_policy',
]) {
  const chain = selectLLMChain(selectorKey, { agentName: 'luna', taskType: 'chart_vision' });
  assert(Array.isArray(chain) && chain.length > 0, `guide selector must resolve: ${selectorKey}`);
}
const visionChain = selectLLMChain('investment.agent_policy', {
  agentName: 'luna',
  taskType: 'chart_vision',
});
assert(
  visionChain.some((entry: any) => /^(openai|openai-oauth|gemini|gemini-oauth|gemini-cli-oauth)$/.test(String(entry?.provider || ''))),
  'documented vision selector must include a supported multimodal provider',
);
assert(!codingGuide.includes('anthropic.Anthropic('), 'coding guide must not recommend direct Anthropic SDK calls');
assert(codingGuide.includes('bots/hub/docs/LLM_ROUTING.md'), 'coding guide must link the internal Hub guide');
assert(codingGuide.includes('docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md'), 'coding guide must link the external Hub guide');

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
assert(llmRoute.includes('llmGatewayContractRoute'), 'Hub must expose machine-readable external gateway contract');
assert(
  llmRoute.includes('requestSchemas') &&
    llmRoute.includes('requiredBodyAppliesTo') &&
    llmRoute.includes('contextSources') &&
    llmRoute.includes('oneOfBody') &&
    llmRoute.includes('readTeamHeader'),
  'Gateway contract must expose machine-readable endpoint schemas and async team visibility rules',
);
assert(
  llmRoute.includes('readOwnedLlmJob') &&
    llmRoute.includes('listOwnedLlmJobs') &&
    llmRoute.includes('sendLlmJobOwnerRequired'),
  'Async job read routes must use fail-closed caller-team owned store APIs',
);
assert(
  llmRoute.includes('providerPolicy') &&
    llmRoute.includes('timeoutPolicy') &&
    llmRoute.includes('backpressurePolicy') &&
    llmRoute.includes('geminiDisabled') &&
    llmRoute.includes('HUB_LLM_GEMINI_DISABLED'),
  'Gateway contract must expose current Gemini provider policy',
);
assert(llmRoute.includes('llmVisionRoute'), 'Hub must expose external vision gateway');
assert(llmRoute.includes('llmEmbeddingsRoute'), 'Hub must expose external embedding gateway');
assert(
  routeRegistry.includes("app.post('/hub/llm/vision', llmLimiter, llmLocalAdmissionMiddleware, llmVisionRoute)") &&
    routeRegistry.includes("app.post('/hub/llm/embeddings', llmLimiter, llmLocalAdmissionMiddleware, llmEmbeddingsRoute)"),
  'Vision and embedding routes must keep local admission while resolved providers own shared admission',
);
assert(
  llmRoute.includes('runWithProviderAdmission') &&
    llmRoute.includes("provider: 'local-embedding'") &&
    llmRoute.includes('const provider = visionProviderFromRoute(route.route)') &&
    llmRoute.includes('team: callerTeam,\n      provider,'),
  'Vision and embedding calls must acquire shared admission for the resolved provider',
);
assert(
  llmRoute.includes('resolveHubLlmSelection') && llmRoute.includes('resolveVisionSelection'),
  'Vision gateway must resolve models through the Hub selector facade',
);
assert(
  !llmRoute.includes("body.model || process.env.HUB_LLM_VISION_MODEL"),
  'Vision gateway must not let clients bypass selector with a raw model override',
);
assert(
  llmRoute.includes('canonicalBase64') && llmRoute.includes('invalid_image_base64'),
  'Vision gateway must canonicalize and validate base64 image payloads',
);
assert(requestContext.includes('x-hub-team'), 'request context must accept X-Hub-Team alias');
assert(requestContext.includes('x-hub-agent'), 'request context must accept X-Hub-Agent alias');
assert(requestContext.includes('x-hub-priority'), 'request context must accept X-Hub-Priority alias');
assert(requestContext.includes('x-hub-trace-id'), 'request context must accept X-Hub-Trace-Id alias');
assert(
  investmentHubClient.includes('_hubClient.classifyHubFailureResponse(') &&
    investmentHubClient.includes('_hubClient.isHubNoDirectFallbackFailure(hubResult)'),
  'Investment/Luna must preserve central Hub policy failures and forbid direct-provider fallback',
);

console.log(JSON.stringify({
  ok: true,
  guides: {
    internal: internalGuidePath,
    external: guidePath,
    onboarding: onboardingPath,
    coding: codingGuidePath,
  },
  contracts: {
    sync_call: '/hub/llm/call',
    async_job: '/hub/llm/jobs',
    vision: '/hub/llm/vision',
    embeddings: '/hub/llm/embeddings',
    gateway_contract: '/hub/llm/gateway-contract',
    auth: 'Bearer HUB_AUTH_TOKEN',
    external_headers: ['X-Hub-Team', 'X-Hub-Agent', 'X-Hub-Priority', 'X-Hub-Trace-Id'],
    observability: 'hub.llm_request_log',
    direct_provider_routes: 'disabled_by_default',
  },
}, null, 2));
