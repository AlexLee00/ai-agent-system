const path = require('node:path');
const { selectLLMChain } = require('../../../packages/core/lib/llm-model-selector.ts');

type RuntimeProfileValue = string | number | boolean | string[] | Record<string, any> | undefined | null;

type RuntimeProfile = {
  runtime_agent?: string;
  claude_code_name?: string;
  claude_code_settings?: string;
  local_llm_base_url?: string;
  selector_key?: string;
  selector_agent?: string;
  selector_options?: Record<string, any>;
  primary_routes?: string[];
  fallback_routes?: string[];
  provider?: string;
  base_url?: string;
  model?: string;
  timeout_ms?: number;
  max_tokens?: number;
  temperature?: number;
  local_image?: boolean;
  engine?: string;
  checkpoint_name?: string;
  workflow_template_path?: string;
  poll_ms?: number;
  max_retries?: number;
  direct_provider?: string;
  direct_model?: string;
  direct_endpoint?: string;
  critical?: boolean;
  [key: string]: RuntimeProfileValue;
};

type TeamProfiles = Record<string, RuntimeProfile>;

type RuntimeProfileDefinition = Omit<RuntimeProfile, 'primary_routes' | 'fallback_routes'> & {
  selector_key?: string;
  selector_agent?: string;
  selector_options?: Record<string, any>;
};

type TeamProfileDefinitions = Record<string, RuntimeProfileDefinition>;

const LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..');
const repoPath = (...parts: string[]) => path.join(PROJECT_ROOT, ...parts);
const HUB_CLAUDE_CODE_SETTINGS_DIR = repoPath('bots', 'hub', 'config', 'claude-code');
const CLAUDE_CODE_SETTINGS: Record<string, string> = {
  'blog-writer': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/blog-writer.settings.json`,
  'claude-ops': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/claude-ops.settings.json`,
  'darwin-research': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/darwin-research.settings.json`,
  'justin-legal': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/justin-legal.settings.json`,
  'luna-ops': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/luna-ops.settings.json`,
  'sigma-data': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/sigma-data.settings.json`,
};

const baseRuntime = (runtimeAgent: keyof typeof CLAUDE_CODE_SETTINGS): RuntimeProfileDefinition => ({
  runtime_agent: runtimeAgent,
  claude_code_name: runtimeAgent,
  claude_code_settings: CLAUDE_CODE_SETTINGS[runtimeAgent],
  local_llm_base_url: LOCAL_LLM_BASE_URL,
});

const blogRuntime = () => baseRuntime('blog-writer');
const lunaRuntime = () => baseRuntime('luna-ops');
const darwinRuntime = () => baseRuntime('darwin-research');
const justinRuntime = () => baseRuntime('justin-legal');
const sigmaRuntime = () => baseRuntime('sigma-data');
const claudeRuntime = () => baseRuntime('claude-ops');
const opsRuntime = () => baseRuntime('claude-ops');

const llm = (
  runtime: RuntimeProfileDefinition,
  selectorKey: string,
  selectorAgent?: string,
  extra: RuntimeProfileDefinition = {},
): RuntimeProfileDefinition => ({
  ...runtime,
  ...extra,
  selector_key: selectorKey,
  selector_agent: selectorAgent,
});

const PROFILE_DEFINITIONS: Record<string, TeamProfileDefinitions> = {
  blog: {
    default: llm(blogRuntime(), 'blog._default'),
    writer: llm(blogRuntime(), 'blog.pos.writer'),
    social: llm(blogRuntime(), 'blog.social.summarize'),
    curriculum: llm(blogRuntime(), 'blog.curriculum.generate'),
    'image-local': {
      ...blogRuntime(),
      local_image: true,
      engine: 'comfyui',
      base_url: 'http://127.0.0.1:8188',
      checkpoint_name: 'sd_xl_base_1.0.safetensors',
      workflow_template_path: repoPath('bots', 'blog', 'config', 'comfyui-workflow-template.json'),
      timeout_ms: 300000,
      poll_ms: 1500,
      max_retries: 3,
    },
    'gemma-topic': llm(blogRuntime(), 'blog._default', undefined, { timeout_ms: 10000, max_tokens: 200, temperature: 0.8 }),
  },
  luna: {
    default: llm(lunaRuntime(), 'investment._default'),
    analyst: llm(lunaRuntime(), 'investment.agent_policy', 'luna'),
    validator: llm(lunaRuntime(), 'investment.sentinel'),
    commander: llm(lunaRuntime(), 'investment.luna'),
    exit_decision: llm(lunaRuntime(), 'investment.nemesis', undefined, { timeout_ms: 10_000, critical: true }),
    portfolio_decision: llm(lunaRuntime(), 'investment.adaptive-risk', undefined, { timeout_ms: 10_000, critical: true }),
    decision_rationale: llm(lunaRuntime(), 'investment.luna', undefined, { critical: false }),
    nemesis_risk: llm(lunaRuntime(), 'investment.nemesis', undefined, { timeout_ms: 8_000, critical: true }),
    sentiment_multilingual: llm(lunaRuntime(), 'investment.sophia'),
    screening_bulk: llm(lunaRuntime(), 'investment.argos'),
    deep_reasoning: llm(lunaRuntime(), 'investment.chronos'),
    debate_agent: llm(lunaRuntime(), 'investment.zeus'),
  },
  darwin: {
    default: llm(darwinRuntime(), 'darwin.agent_policy', 'darwin.edison'),
    research: llm(darwinRuntime(), 'darwin.agent_policy', 'darwin.evaluator'),
    synthesis: llm(darwinRuntime(), 'darwin.agent_policy', 'darwin.planner'),
    review: llm(darwinRuntime(), 'darwin.agent_policy', 'darwin.verifier'),
  },
  justin: {
    default: llm(justinRuntime(), 'justin._default'),
    'stage-3': llm(justinRuntime(), 'justin.stage-3'),
    citation: llm(justinRuntime(), 'justin.citation'),
    analysis: llm(justinRuntime(), 'justin.analysis'),
    opinion: llm(justinRuntime(), 'justin.opinion'),
    'simple-qa': llm(justinRuntime(), 'justin.simple-qa'),
  },
  sigma: {
    default: llm(sigmaRuntime(), 'sigma.agent_policy', 'mapek.monitor'),
    quality: llm(sigmaRuntime(), 'sigma.agent_policy', 'skill.data_quality'),
    experiment: llm(sigmaRuntime(), 'sigma.agent_policy', 'skill.experiment_design'),
    analysis: llm(sigmaRuntime(), 'sigma.agent_policy', 'skill.causal'),
  },
  claude: {
    default: llm(claudeRuntime(), 'claude._default'),
    reporting: llm(claudeRuntime(), 'claude._default'),
    triage: llm(claudeRuntime(), 'claude.lead.system_issue_triage'),
    lead: llm(claudeRuntime(), 'claude.lead.system_issue_triage'),
  },
  orchestrator: {
    default: llm(opsRuntime(), 'orchestrator.jay.intent'),
    intent: llm(opsRuntime(), 'orchestrator.jay.intent'),
    fallback: llm(opsRuntime(), 'orchestrator.jay.chat_fallback'),
    summary: llm(opsRuntime(), 'orchestrator.jay.summary'),
    steward: llm(opsRuntime(), 'orchestrator.steward.work', undefined, { timeout_ms: 18000, max_tokens: 320, temperature: 0.2 }),
    'steward-digest': llm(opsRuntime(), 'orchestrator.steward.digest', undefined, { timeout_ms: 12000, max_tokens: 220, temperature: 0.1 }),
    'steward-incident': llm(opsRuntime(), 'orchestrator.steward.incident_plan', undefined, { timeout_ms: 25000, max_tokens: 700, temperature: 0.2 }),
    'steward-pro-canary': llm(opsRuntime(), 'orchestrator.steward.pro_canary', undefined, { timeout_ms: 60000, max_tokens: 128, temperature: 0.2 }),
    'gemma-insight': llm(opsRuntime(), 'orchestrator.steward.work', undefined, { timeout_ms: 10000, max_tokens: 300, temperature: 0.7 }),
  },
  hub: {
    default: llm(opsRuntime(), 'hub._default'),
    'alarm.classifier': llm(opsRuntime(), 'hub.alarm.classifier', undefined, { timeout_ms: 8000, max_tokens: 500, temperature: 0 }),
    'alarm.interpreter.work': llm(opsRuntime(), 'hub.alarm.interpreter.work'),
    'alarm.interpreter.report': llm(opsRuntime(), 'hub.alarm.interpreter.report'),
    'alarm.interpreter.error': llm(opsRuntime(), 'hub.alarm.interpreter.error'),
    'alarm.interpreter.critical': llm(opsRuntime(), 'hub.alarm.interpreter.critical', undefined, { critical: true }),
    'roundtable.jay': llm(opsRuntime(), 'hub.roundtable.jay'),
    'roundtable.claude_lead': llm(opsRuntime(), 'hub.roundtable.claude_lead'),
    'roundtable.team_commander': llm(opsRuntime(), 'hub.roundtable.team_commander'),
    'roundtable.judge': llm(opsRuntime(), 'hub.roundtable.judge'),
    'control.planner': llm(opsRuntime(), 'hub.control.planner'),
    'session.compaction': llm(opsRuntime(), 'hub.session.compaction'),
    'oauth.gemini_cli.expiry_probe': llm(opsRuntime(), 'hub.oauth.gemini_cli.expiry_probe'),
    'gemini.cli.adapter.smoke': llm(opsRuntime(), 'hub.gemini.cli.adapter.smoke'),
    'gemini.cli.readiness.live': llm(opsRuntime(), 'hub.gemini.cli.readiness.live'),
    'unified.oauth.openai.smoke': llm(opsRuntime(), 'hub.unified.oauth.openai.smoke'),
    'unified.oauth.gemini.smoke': llm(opsRuntime(), 'hub.unified.oauth.gemini.smoke'),
  },
  ska: {
    default: llm(opsRuntime(), 'ska._default'),
    'gemma-insight': llm(opsRuntime(), 'ska.classify', undefined, { timeout_ms: 10000, max_tokens: 150, temperature: 0.7 }),
    monitoring: llm(opsRuntime(), 'ska._default'),
    reporting: llm(opsRuntime(), 'ska._default'),
  },
};

function routeLabel(entry: any): string | null {
  const provider = String(entry?.provider || '').trim();
  const model = String(entry?.model || '').trim();
  if (!provider || !model) return null;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

function selectorOptionsFor(profileName: string, definition: RuntimeProfileDefinition): Record<string, any> {
  return {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: `runtime-profile:${profileName}`,
    agentName: definition.selector_agent,
    maxTokens: definition.max_tokens,
    temperature: definition.temperature,
    ...(definition.selector_options || {}),
  };
}

function materializeProfile(team: string, profileName: string, definition: RuntimeProfileDefinition): RuntimeProfile {
  if (!definition.selector_key) return { ...definition };
  const chain = selectLLMChain(definition.selector_key, selectorOptionsFor(`${team}.${profileName}`, definition));
  const routes = chain.map(routeLabel).filter(Boolean) as string[];
  return {
    ...definition,
    primary_routes: routes.slice(0, 1),
    fallback_routes: routes.slice(1),
  };
}

function materializeProfiles(definitions: Record<string, TeamProfileDefinitions>): Record<string, TeamProfiles> {
  const profiles: Record<string, TeamProfiles> = {};
  for (const [team, teamProfiles] of Object.entries(definitions)) {
    profiles[team] = {};
    for (const [profileName, definition] of Object.entries(teamProfiles)) {
      profiles[team][profileName] = materializeProfile(team, profileName, definition);
    }
  }
  return profiles;
}

export const PROFILES: Record<string, TeamProfiles> = materializeProfiles(PROFILE_DEFINITIONS);

export function selectRuntimeProfile(team: string | null | undefined, purpose = 'default'): RuntimeProfile | null {
  const normalizedTeam = String(team || '').trim().toLowerCase();
  const normalizedPurpose = String(purpose || 'default').trim().toLowerCase() || 'default';
  if (!normalizedTeam) return null;

  const teamProfiles = PROFILES[normalizedTeam];
  if (!teamProfiles) return null;

  return teamProfiles[normalizedPurpose] || teamProfiles.default || null;
}

export {
  LOCAL_LLM_BASE_URL,
};
