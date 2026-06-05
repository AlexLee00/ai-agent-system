// @ts-nocheck
'use strict';

const LIVE_SENSITIVE_WORDS = /(live|실투자|cutover|strategy-tune|signal-add|position|포지션|매수|매도|order|주문|trade|거래|tp\/sl|stop[-_\s]?loss|take[-_\s]?profit)/i;
const LIVE_SENSITIVE_KEYS = /(exchange|order|trade|position|quantity|qty|notional|amount|price|symbol|tp|sl|stopLoss|takeProfit)/i;
const MUTATING_SIDE_EFFECTS = new Set(['write', 'external_mutation', 'money_movement']);
const VALID_MODES = new Set(['off', 'shadow', 'canary', 'full']);
const TEAM_ALIASES = {
  investment: 'luna',
  reservation: 'ska',
  claude_lead: 'claude',
  'claude-lead': 'claude',
};

let symphonyOrchestrator = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeMode(value) {
  const mode = normalizeText(value, 'off').toLowerCase();
  return VALID_MODES.has(mode) ? mode : 'off';
}

function parseBoolean(value, fallback = false) {
  if (value == null || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => normalizeTeam(item))
    .filter(Boolean);
}

function normalizeTeam(value, fallback = '') {
  const team = normalizeText(value, fallback).toLowerCase().replace(/\s+/g, '_');
  return TEAM_ALIASES[team] || team;
}

function normalizePriority(value) {
  const priority = normalizeText(value, 'normal').toLowerCase();
  if (['low', 'normal', 'high'].includes(priority)) return priority;
  return 'normal';
}

function textOf(input) {
  if (input === undefined || input === null) return '';
  if (Array.isArray(input)) return input.map(textOf).filter(Boolean).join(' ');
  if (typeof input === 'object') return Object.values(input).map(textOf).join(' ');
  return String(input);
}

function sideEffectOf(step = {}) {
  return normalizeText(step.sideEffect || step.side_effect, 'read_only').toLowerCase();
}

function stepArgsContainLiveKey(args = {}) {
  if (!args || typeof args !== 'object') return false;
  return Object.keys(args).some((key) => LIVE_SENSITIVE_KEYS.test(key));
}

function resolveSymphonyCutoverConfig(env = process.env) {
  const mode = normalizeMode(env.JAY_SYMPHONY_CUTOVER_MODE);
  const cutoverTeams = parseList(env.JAY_SYMPHONY_CUTOVER_TEAMS);
  const shadowTeams = parseList(env.JAY_SYMPHONY_SHADOW_TEAMS || env.JAY_SYMPHONY_CUTOVER_TEAMS);
  return {
    mode,
    enabled: mode !== 'off',
    forceCommander: parseBoolean(env.JAY_SYMPHONY_FORCE_COMMANDER, true),
    liveSensitiveBlock: parseBoolean(env.JAY_SYMPHONY_LIVE_SENSITIVE_BLOCK, true),
    canaryPercent: parseNumber(env.JAY_SYMPHONY_CANARY_PERCENT, 0, 0, 100),
    cutoverTeams,
    shadowTeams,
  };
}

function isTeamAllowedForShadow(team, config = {}) {
  if (!config.enabled) return false;
  const normalized = normalizeTeam(team, 'general');
  if (!config.shadowTeams || config.shadowTeams.length === 0) return true;
  return config.shadowTeams.includes(normalized);
}

function loadBuildTaskPlan() {
  if (!symphonyOrchestrator) {
    symphonyOrchestrator = require('../../claude/lib/symphony/orchestrator.ts');
  }
  return symphonyOrchestrator.buildTaskPlan;
}

function isLiveSensitivePlanStep(input = {}, config = {}) {
  const incident = input.incident || {};
  const plan = input.plan || {};
  const step = input.step || {};
  const team = normalizeTeam(incident.team || plan.team, 'general');
  if (team !== 'luna') return false;
  if (config.liveSensitiveBlock === false) return false;
  const sideEffect = sideEffectOf(step);
  if (MUTATING_SIDE_EFFECTS.has(sideEffect)) return true;
  if (stepArgsContainLiveKey(step.args)) return true;
  const text = textOf([
    input.goal,
    incident.intent,
    incident.message,
    incident.args,
    step.id,
    step.tool,
    step.notes,
    step.args,
  ]);
  return LIVE_SENSITIVE_WORDS.test(text);
}

function buildSymphonyShadowTask(input = {}, config = {}) {
  const incident = input.incident || {};
  const step = input.step || {};
  const legacyTeam = normalizeTeam(input.legacyTeam || incident.team || input.plan?.team, 'general');
  const liveSensitive = isLiveSensitivePlanStep(input, config);
  const body = [
    normalizeText(input.goal || incident.message || '', ''),
    normalizeText(step.notes, ''),
    normalizeText(step.tool, ''),
    textOf(step.args).slice(0, 1200),
  ].filter(Boolean).join('\n\n');
  return {
    id: `jay:${normalizeText(incident.incidentKey || incident.id || 'incident')}:${normalizeText(step.id, 'step')}`,
    source: 'hub',
    target_team: legacyTeam,
    title: normalizeText(step.notes || input.goal || incident.intent || incident.message, 'Jay commander plan step'),
    body,
    priority: normalizePriority(incident.priority),
    status: 'todo',
    ticket_type: 'jay_commander_plan_step',
    source_ref: incident.incidentKey || incident.id || null,
    metadata: {
      legacyTeam,
      incidentKey: incident.incidentKey || null,
      incidentIntent: incident.intent || null,
      planStepId: step.id || null,
      planTool: step.tool || null,
      sideEffect: sideEffectOf(step),
      requires_live_execution: liveSensitive,
    },
  };
}

function buildAgreement(input = {}) {
  const legacyTeam = normalizeTeam(input.legacyTeam, 'general');
  const symphonyTeam = normalizeTeam(input.symphonyTeam, '');
  const legacyLiveSensitive = Boolean(input.legacyLiveSensitive);
  const symphonyLiveSensitive = Boolean(input.symphonyLiveSensitive);
  return {
    teamMatches: legacyTeam === symphonyTeam,
    liveGuardMatches: !legacyLiveSensitive || symphonyLiveSensitive,
    liveSensitiveFalseNegative: legacyLiveSensitive && !symphonyLiveSensitive,
  };
}

function evaluateSymphonyShadowDecision(input = {}, options = {}) {
  const config = options.config || resolveSymphonyCutoverConfig(options.env || process.env);
  const incident = input.incident || {};
  const step = input.step || {};
  const legacyTeam = normalizeTeam(input.legacyTeam || incident.team || input.plan?.team, 'general');
  const legacyLiveSensitive = isLiveSensitivePlanStep({ ...input, step }, config);
  const task = buildSymphonyShadowTask({ ...input, legacyTeam, step }, config);
  const buildTaskPlan = options.buildTaskPlan || loadBuildTaskPlan();
  const plan = buildTaskPlan(task, options.symphonyOptions || {});
  const symphonyLiveSensitive = Boolean(
    plan?.symphonyTask?.metadata?.requiresLiveExecution
      || (Array.isArray(plan?.blockers) && plan.blockers.includes('luna_live_sensitive_ticket_requires_shadow_or_master_approval'))
  );
  const symphonyTeam = normalizeTeam(plan?.dispatch?.targetTeam, '');
  return {
    ok: true,
    mode: config.mode,
    dryRun: true,
    selectedRoute: 'legacy_commander',
    generatedAt: new Date().toISOString(),
    legacy: {
      team: legacyTeam,
      incidentKey: incident.incidentKey || null,
      intent: incident.intent || null,
      stepId: step.id || null,
      tool: step.tool || null,
      sideEffect: sideEffectOf(step),
      liveSensitive: legacyLiveSensitive,
    },
    symphony: {
      team: symphonyTeam || null,
      agent: plan?.dispatch?.agent || null,
      role: plan?.dispatch?.role || null,
      confidence: Number(plan?.dispatch?.confidence || 0),
      ok: Boolean(plan?.ok),
      blockers: Array.isArray(plan?.blockers) ? plan.blockers : [],
      warnings: Array.isArray(plan?.warnings) ? plan.warnings : [],
      liveSensitive: symphonyLiveSensitive,
    },
    agreement: buildAgreement({
      legacyTeam,
      symphonyTeam,
      legacyLiveSensitive,
      symphonyLiveSensitive,
    }),
    safety: {
      mutatesRuntime: false,
      mutatesHub: false,
      mutatesGit: false,
      mutatesLaunchd: false,
      mutatesSecrets: false,
      executesRunner: false,
      executesCommander: false,
      sourceOfTruth: 'legacy_commander',
    },
  };
}

function buildSymphonyCutoverShadowReports(input = {}, options = {}) {
  const config = options.config || resolveSymphonyCutoverConfig(options.env || process.env);
  if (!config.enabled) return [];
  const incident = input.incident || {};
  const plan = input.plan || {};
  const goal = input.goal || '';
  const steps = Array.isArray(input.steps) ? input.steps : [];
  const legacyTeam = normalizeTeam(incident.team || plan.team, 'general');
  if (!isTeamAllowedForShadow(legacyTeam, config)) return [];
  return steps.map((step) => evaluateSymphonyShadowDecision({
    incident,
    plan,
    step,
    goal,
    legacyTeam,
  }, {
    ...options,
    config,
  }));
}

module.exports = {
  buildAgreement,
  buildSymphonyCutoverShadowReports,
  buildSymphonyShadowTask,
  evaluateSymphonyShadowDecision,
  isLiveSensitivePlanStep,
  isTeamAllowedForShadow,
  normalizeTeam,
  resolveSymphonyCutoverConfig,
  _testOnly: {
    LIVE_SENSITIVE_WORDS,
    LIVE_SENSITIVE_KEYS,
    MUTATING_SIDE_EFFECTS,
    sideEffectOf,
    textOf,
  },
};
