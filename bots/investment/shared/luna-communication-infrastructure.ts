// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';

export const LUNA_COMMUNICATION_PHASE = 'phase9_communication_infrastructure';

export const REQUIRED_A2A_SKILLS = [
  'market-regime-analysis',
  'entry-decision-shadow',
  'dynamic-tpsl-shadow',
  'meta-neural-reflexion',
  'factor-model-shadow',
  'stat-arb-shadow',
  'rl-policy-shadow',
  'policy-inference',
  'policy-update',
  'risk-simulation-shadow',
  'monte-carlo-shadow',
  'stress-test-shadow',
  'n-agent-debate',
  'communication-infrastructure-gate',
  'hybrid-promotion-gate',
  'hybrid-promotion-review',
];

export const REQUIRED_A2A_CORE_FILES = [
  'a2a/server.ts',
  'a2a/client.ts',
  'a2a/handlers/task-handler.ts',
  'a2a/handlers/message-handler.ts',
  'a2a/handlers/notification-handler.ts',
  'a2a/luna-card.json',
  'a2a/luna-rl-card.json',
];

export const REQUIRED_HOOK_SCRIPTS = [
  '.claude/hooks/scripts/luna-pretooluse-policy-check.sh',
  '.claude/hooks/scripts/luna-posttooluse-feedback.sh',
  '.claude/hooks/scripts/luna-sessionstart-daily-brief.sh',
  '.claude/hooks/scripts/luna-stop-session-summary.sh',
];

export const REQUIRED_SHADOW_RUNTIME_COMMANDS = [
  'runtime:luna-regime-llm-shadow',
  'runtime:luna-entry-llm-shadow',
  'runtime:luna-dynamic-tpsl-shadow',
  'runtime:luna-meta-reflexion-shadow',
  'runtime:luna-factor-model-shadow',
  'runtime:luna-stat-arb-shadow',
  'runtime:luna-rl-policy-shadow',
  'runtime:luna-monte-carlo-stress-shadow',
  'runtime:luna-communication-infra-gate',
  'runtime:luna-hybrid-promotion-gate',
  'runtime:luna-hybrid-promotion-review',
];

export const REQUIRED_DEBATE_FILES = [
  'nodes/l11-bull-debate.ts',
  'nodes/l11b-quant-debate.ts',
  'nodes/l12-bear-debate.ts',
  'nodes/l12b-risk-debate.ts',
  'nodes/l13-final-decision.ts',
];

export const REQUIRED_REFLEXION_FILES = [
  'elixir/lib/luna/v2/reflexion/l1_immediate.ex',
  'elixir/lib/luna/v2/reflexion/l2_daily.ex',
  'elixir/lib/luna/v2/reflexion/l3_weekly.ex',
  'elixir/lib/mix/tasks/luna.reflexion.ex',
];

export const COMMUNICATION_CHANNEL_CONTRACT = [
  'luna:mapek_events',
  'luna:quant_signals',
  'luna:rl_actions',
  'cross_team:investments',
  'cross_team:darwin_rnd',
  'cross_team:sigma_meta',
];

function defaultInvestmentRoot() {
  return path.resolve(import.meta.dirname, '..');
}

function projectRootFromInvestmentRoot(investmentRoot) {
  return path.resolve(investmentRoot, '../..');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function existsFrom(root, relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function checkContains(name, haystack, needles, detailPrefix = 'missing') {
  const missing = needles.filter((needle) => !haystack.includes(needle));
  return {
    name,
    ok: missing.length === 0,
    missing,
    detail: missing.length === 0 ? 'ready' : `${detailPrefix}: ${missing.join(', ')}`,
  };
}

export function buildLunaCommunicationInfrastructureReport(options = {}) {
  const investmentRoot = path.resolve(options.investmentRoot || defaultInvestmentRoot());
  const projectRoot = path.resolve(options.projectRoot || projectRootFromInvestmentRoot(investmentRoot));
  const checks = [];

  const addCheck = (check) => checks.push(check);
  const addFileGroupCheck = (name, root, files) => {
    const missing = files.filter((file) => !existsFrom(root, file));
    addCheck({
      name,
      ok: missing.length === 0,
      missing,
      detail: missing.length === 0 ? 'ready' : `missing: ${missing.join(', ')}`,
    });
  };

  addFileGroupCheck('a2a_core_files', investmentRoot, REQUIRED_A2A_CORE_FILES);
  addFileGroupCheck('hook_scripts', projectRoot, REQUIRED_HOOK_SCRIPTS);
  addFileGroupCheck('n_agent_debate_files', investmentRoot, REQUIRED_DEBATE_FILES);
  addFileGroupCheck('reflexion_layer_files', investmentRoot, REQUIRED_REFLEXION_FILES);

  const lunaCard = readJson(path.join(investmentRoot, 'a2a/luna-card.json')) || {};
  const cardSkillIds = new Set((lunaCard.skills || []).map((skill) => skill.id).filter(Boolean));
  const missingSkills = REQUIRED_A2A_SKILLS.filter((skillId) => !cardSkillIds.has(skillId));
  addCheck({
    name: 'a2a_skill_card_contract',
    ok: missingSkills.length === 0,
    missing: missingSkills,
    detail: missingSkills.length === 0 ? `${cardSkillIds.size} skills registered` : `missing: ${missingSkills.join(', ')}`,
  });

  const serverText = readText(path.join(investmentRoot, 'a2a/server.ts'));
  addCheck(checkContains('a2a_server_skill_registration', serverText, [
    'registerMarketRegimeAnalysisSkill',
    'registerEntryDecisionShadowSkill',
    'registerDynamicTpSlShadowSkill',
    'registerMetaNeuralReflexionSkill',
    'registerFactorModelShadowSkill',
    'registerStatArbShadowSkill',
    'registerRlPolicyShadowSkills',
    'registerRiskSimulationShadowSkills',
    'registerCommunicationInfrastructureGateSkill',
    'registerHybridPromotionGateSkill',
    'registerHybridPromotionReviewSkill',
  ]));

  const hooksConfigText = readText(path.join(projectRoot, '.claude/hooks/hooks.json'));
  addCheck(checkContains('hook_config_wiring', hooksConfigText, [
    'PreToolUse',
    'PostToolUse',
    'SessionStart',
    'Stop',
    'luna-pretooluse-policy-check.sh',
    'luna-posttooluse-feedback.sh',
    'luna-sessionstart-daily-brief.sh',
    'luna-stop-session-summary.sh',
  ]));

  const preHookText = readText(path.join(projectRoot, '.claude/hooks/scripts/luna-pretooluse-policy-check.sh'));
  addCheck(checkContains('hook_shadow_runtime_allowlist', preHookText, REQUIRED_SHADOW_RUNTIME_COMMANDS));
  addCheck({
    name: 'hook_confirm_apply_not_allowlisted',
    ok: !preHookText.includes('re.compile(r"^--apply$")') && !preHookText.includes('confirm='),
    detail: 'read-only shadow allowlist excludes apply/confirm arguments',
  });

  const clientText = readText(path.join(investmentRoot, 'a2a/client.ts'));
  addCheck(checkContains('cross_team_a2a_targets', clientText, [
    'darwin',
    'sigma',
    'reporter',
    'broadcast(',
  ]));

  const finalDecisionText = readText(path.join(investmentRoot, 'nodes/l13-final-decision.ts'));
  addCheck(checkContains('n_agent_debate_consensus', finalDecisionText, [
    'computeDebateConsensus',
    'bull',
    'bear',
    'quant',
    'risk',
  ]));

  const reflexionTaskText = readText(path.join(investmentRoot, 'elixir/lib/mix/tasks/luna.reflexion.ex'));
  addCheck(checkContains('reflexion_mix_task_layers', reflexionTaskText, [
    '--layer=1',
    '--layer=2',
    '--layer=3',
  ]));

  const commanderText = readText(path.join(investmentRoot, 'elixir/lib/luna/v2/commander.ex'));
  const monitorText = readText(path.join(investmentRoot, 'elixir/lib/luna/v2/mapek/monitor.ex'));
  addCheck({
    name: 'pubsub_runtime_contract',
    ok: commanderText.includes('Phoenix.PubSub.broadcast') && `${commanderText}\n${monitorText}`.includes('luna:mapek_events'),
    channels: COMMUNICATION_CHANNEL_CONTRACT,
    detail: 'luna:mapek_events runtime channel ready; cross-team channel names fixed as Phase 9 contract',
  });

  const phaseSkillFiles = [
    'a2a/skills/market-regime-analysis.ts',
    'a2a/skills/entry-decision-shadow.ts',
    'a2a/skills/dynamic-tpsl-shadow.ts',
    'a2a/skills/meta-neural-reflexion.ts',
    'a2a/skills/factor-model-shadow.ts',
    'a2a/skills/stat-arb-shadow.ts',
    'a2a/skills/rl-policy-shadow.ts',
    'a2a/skills/risk-simulation-shadow.ts',
    'a2a/skills/communication-infrastructure-gate.ts',
    'a2a/skills/hybrid-promotion-gate.ts',
    'a2a/skills/hybrid-promotion-review.ts',
  ];
  const broadcastChecks = phaseSkillFiles.map((file) => ({
    file,
    hasEnvGate: readText(path.join(investmentRoot, file)).includes('LUNA_A2A_BROADCAST_ENABLED'),
  }));
  const missingBroadcastGate = broadcastChecks.filter((item) => !item.hasEnvGate).map((item) => item.file);
  addCheck({
    name: 'a2a_broadcast_default_off',
    ok: missingBroadcastGate.length === 0,
    missing: missingBroadcastGate,
    detail: missingBroadcastGate.length === 0
      ? 'all Phase 1-11 A2A skills require LUNA_A2A_BROADCAST_ENABLED=true for broadcastPlanned'
      : `missing env gate: ${missingBroadcastGate.join(', ')}`,
  });

  const failures = checks.filter((check) => !check.ok);
  const ok = failures.length === 0;

  return {
    ok,
    phase: LUNA_COMMUNICATION_PHASE,
    status: ok ? 'communication_infrastructure_ready' : 'communication_infrastructure_blocked',
    shadowMode: true,
    liveMutation: false,
    broadcastDefault: 'off_unless_LUNA_A2A_BROADCAST_ENABLED_true',
    channels: COMMUNICATION_CHANNEL_CONTRACT,
    requiredSkills: REQUIRED_A2A_SKILLS,
    checks,
    failures,
    summary: {
      totalChecks: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
      a2aSkills: cardSkillIds.size,
      protectedPidMutation: false,
    },
    generatedAt: new Date().toISOString(),
  };
}

export default {
  buildLunaCommunicationInfrastructureReport,
  LUNA_COMMUNICATION_PHASE,
  REQUIRED_A2A_SKILLS,
  COMMUNICATION_CHANNEL_CONTRACT,
};
