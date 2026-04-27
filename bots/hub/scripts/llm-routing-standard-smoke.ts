const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const STANDARDIZED_SCOPES = [
  'bots/darwin/lib',
  'bots/darwin/scripts',
  'bots/video/lib',
  'bots/video/config',
  'bots/orchestrator/src/router.ts',
  'bots/orchestrator/lib/intent-parser.ts',
  'bots/worker/lib/ai-client.ts',
  'bots/worker/lib/chat-agent.ts',
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

const REQUIRED_VIDEO_AGENTS = [
  'edi',
  'critic',
  'subtitle-corrector',
  'scene-indexer',
  'narration-analyzer',
  'refiner',
  'intro-outro-handler',
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

function rg(args) {
  return spawnSync('rg', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertNoMatches(pattern, scopes, label) {
  const result = rg(['-n', '-S', pattern, ...scopes]);
  const matches = String(result.stdout || '').trim();
  if (matches) {
    throw new Error(`${label} must be routed through Hub callHubLlm, but found:\n${matches}`);
  }
  assert.ok(result.status === 0 || result.status === 1, `${label} rg failed: ${result.stderr || result.status}`);
}

function assertHasMatches(pattern, scopes, label) {
  const result = rg(['-n', '-S', pattern, ...scopes]);
  const matches = String(result.stdout || '').trim();
  assert.ok(matches, `${label} expected matches for ${pattern}`);
}

function main() {
  assertNoMatches('llm-fallback|callWithFallback|selectLLMChain|llm_provider|llm_model|red_model', STANDARDIZED_SCOPES, 'standardized team LLM scopes');
  assertHasMatches('callHubLlm', STANDARDIZED_SCOPES, 'standardized team LLM scopes');

  const selector = require('../../../packages/core/lib/llm-model-selector.ts');
  for (const agent of REQUIRED_VIDEO_AGENTS) {
    const description = selector.describeAgentModel('video', agent);
    assert.ok(description?.selected, `video/${agent} must resolve to a selector chain`);
    assert.ok(Array.isArray(description.chain) && description.chain.length > 0, `video/${agent} selector chain must be non-empty`);
  }

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
    'luna/default must start with OpenAI OAuth via investment.agent_policy openai_perf route',
  );

  const hubClient = require('../../../packages/core/lib/hub-client');
  assert.strictEqual(typeof hubClient.callHubLlm, 'function', 'hub-client must export callHubLlm');

  console.log(JSON.stringify({
    ok: true,
    standardized_scopes: STANDARDIZED_SCOPES,
    video_agents: REQUIRED_VIDEO_AGENTS.length,
    darwin_profiles: REQUIRED_DARWIN_PROFILES.length,
    blog_agents: REQUIRED_BLOG_AGENTS.length,
    ska_agents: REQUIRED_SKA_AGENTS.length,
    investment_agents: REQUIRED_INVESTMENT_AGENTS.length,
  }, null, 2));
}

main();
