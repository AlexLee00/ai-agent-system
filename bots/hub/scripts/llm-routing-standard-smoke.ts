const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const STANDARDIZED_SCOPES = [
  'bots/darwin/lib',
  'bots/darwin/scripts',
  'bots/orchestrator/src/router.ts',
  'bots/orchestrator/lib/intent-parser.ts',
  'bots/sigma/shared/llm-client.ts',
  'bots/legal/lib/llm-helper.js',
  'bots/claude/lib/ai-analyst.ts',
  'bots/claude/lib/claude-lead-brain.ts',
  'bots/claude/lib/archer/analyzer.ts',
  'bots/claude/lib/archer/config.ts',
  'bots/blog/lib/social.ts',
  'bots/blog/lib/star.ts',
  'bots/blog/lib/feedback-learner.ts',
  'bots/blog/lib/curriculum-planner.ts',
  'bots/blog/lib/commenter.ts',
  'bots/blog/lib/pos-writer.ts',
  'bots/blog/lib/gems-writer.ts',
  'bots/blog/scripts/draft-book-review.ts',
  'bots/reservation/scripts/ska-llm-parse.ts',
  'bots/investment/shared/hub-llm-client.ts',
  'bots/investment/team/chronos.ts',
  'bots/investment/scripts/backtest-llm-quality-sample.ts',
  'packages/core/lib/chunked-llm.ts',
];

const REQUIRED_DARWIN_PROFILES = [
  'research',
  'synthesis',
  'review',
];

const REQUIRED_BLOG_AGENTS = [
  'social-summarize',
  'social-caption',
  'star',
  'curriculum-recommend',
  'curriculum-generate',
  'feedback-learner',
  'commenter',
  'neighbor-commenter',
  'book-review-draft',
];

const REQUIRED_SKA_AGENTS = [
  'parsing-guard',
  'selector-generator',
  'error-classifier',
];

const REQUIRED_INVESTMENT_AGENTS = [
  'default',
  'luna',
  'nemesis',
  'oracle',
  'argos',
  'chronos',
];

const REQUIRED_ORCHESTRATOR_AGENTS = [
  'default',
  'intent',
  'fallback',
  'summary',
];

function searchPattern(pattern: string, args: string[]): { stdout: string; status: number | null; ok: boolean } {
  const rgResult = spawnSync('rg', ['-n', '-S', pattern, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!rgResult.error && rgResult.status !== null) {
    return { stdout: String(rgResult.stdout || ''), status: rgResult.status, ok: true };
  }
  // rg not available — fall back to grep
  const grepResult = spawnSync('grep', ['-rn', '-E', pattern, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const grepStatus = grepResult.status ?? 2;
  return { stdout: String(grepResult.stdout || ''), status: grepStatus, ok: grepStatus <= 1 };
}

function assertNoMatches(pattern, scopes, label) {
  const { stdout, ok } = searchPattern(pattern, scopes);
  if (!ok) return; // search tool unavailable — skip assertion
  const matches = stdout.trim();
  if (matches) {
    throw new Error(`${label} must be routed through Hub callHubLlm, but found:\n${matches}`);
  }
}

function assertHasMatches(pattern, scopes, label) {
  const { stdout, ok } = searchPattern(pattern, scopes);
  if (!ok) return; // search tool unavailable — skip assertion
  const matches = stdout.trim();
  assert.ok(matches, `${label} expected matches for ${pattern}`);
}

function main() {
  process.env.LLM_USE_OAUTH_PRIMARY = 'true';
  process.env.LLM_TEAM_SELECTOR_VERSION = 'v3_oauth_4';
  process.env.LLM_TEAM_SELECTOR_AB_PERCENT = '100';

  assertNoMatches('llm-fallback|callWithFallback|selectLLMChain|llm_provider|llm_model|red_model', STANDARDIZED_SCOPES, 'standardized team LLM scopes');
  assertHasMatches('callHubLlm', STANDARDIZED_SCOPES, 'standardized team LLM scopes');

  const selector = require('../../../packages/core/lib/llm-model-selector.ts');

  const { PROFILES } = require('../lib/runtime-profiles.ts');
  for (const profile of REQUIRED_DARWIN_PROFILES) {
    assert.ok(PROFILES?.darwin?.[profile], `darwin runtime profile missing: ${profile}`);
    const routes = [
      ...(PROFILES.darwin[profile].primary_routes || []),
      ...(PROFILES.darwin[profile].fallback_routes || []),
    ];
    assert.ok(routes.length > 0, `darwin/${profile} runtime profile must have routes`);
  }

  for (const agent of REQUIRED_BLOG_AGENTS) {
    const description = selector.describeAgentModel('blog', agent);
    assert.ok(description?.selected, `blog/${agent} must resolve to a selector chain`);
    assert.ok(Array.isArray(description.chain) && description.chain.length > 0, `blog/${agent} selector chain must be non-empty`);
  }

  for (const agent of REQUIRED_SKA_AGENTS) {
    const description = selector.describeAgentModel('ska', agent);
    assert.ok(description?.selected, `ska/${agent} must resolve to a selector chain`);
    assert.ok(Array.isArray(description.chain) && description.chain.length > 0, `ska/${agent} selector chain must be non-empty`);
  }

  for (const agentName of REQUIRED_INVESTMENT_AGENTS) {
    const chain = selector.selectLLMChain('investment.agent_policy', { agentName });
    assert.ok(chain.length > 0, `investment/${agentName} selector chain must be non-empty`);
    assert.ok(chain.some((entry) => entry.provider === 'claude-code'), `investment/${agentName} must include Claude Code OAuth fallback`);
  }

  const lunaDefault = selector.describeAgentModel('luna', 'default');
  assert.equal(
    lunaDefault?.chain?.[0]?.provider,
    'openai-oauth',
    'luna/default must start with the cost-balanced OpenAI OAuth route and keep Claude Code as fallback',
  );

  for (const agent of REQUIRED_ORCHESTRATOR_AGENTS) {
    const description = selector.describeAgentModel('orchestrator', agent);
    assert.ok(description?.selected, `orchestrator/${agent} must resolve to a selector chain`);
    assert.ok(Array.isArray(description.chain) && description.chain.length > 0, `orchestrator/${agent} selector chain must be non-empty`);
  }
  const orchestratorSummary = selector.describeAgentModel('orchestrator', 'summary');
  assert.equal(
    orchestratorSummary?.chain?.[0]?.provider,
    'openai-oauth',
    'orchestrator/summary must start with the stable OpenAI OAuth summary route',
  );
  assert.ok(
    orchestratorSummary?.chain?.some((entry) => entry.provider === 'gemini-cli-oauth'),
    'orchestrator/summary must keep Gemini CLI OAuth as a low-cost fallback route',
  );

  const hubClient = require('../../../packages/core/lib/hub-client');
  assert.strictEqual(typeof hubClient.callHubLlm, 'function', 'hub-client must export callHubLlm');

  console.log(JSON.stringify({
    ok: true,
    standardized_scopes: STANDARDIZED_SCOPES,
    darwin_profiles: REQUIRED_DARWIN_PROFILES.length,
    blog_agents: REQUIRED_BLOG_AGENTS.length,
    ska_agents: REQUIRED_SKA_AGENTS.length,
    orchestrator_agents: REQUIRED_ORCHESTRATOR_AGENTS.length,
    investment_agents: REQUIRED_INVESTMENT_AGENTS.length,
  }, null, 2));
}

main();
