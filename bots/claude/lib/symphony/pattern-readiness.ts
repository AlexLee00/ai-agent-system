// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_MCP_SERVERS = [
  {
    id: 'claude-symphony-mcp',
    rel: 'bots/claude/mcp/claude-symphony-mcp/src/server.ts',
    tools: ['poll_tasks', 'dispatch_ticket', 'get_task_status', 'update_task'],
  },
  {
    id: 'claude-doctor-mcp',
    rel: 'bots/claude/mcp/claude-doctor-mcp/src/server.ts',
    tools: ['diagnose_system', 'get_health', 'heal_service', 'get_recovery_log'],
    requiredText: ['PROTECTED_SERVICES', '자동 재시작 금지'],
  },
  {
    id: 'claude-dexter-mcp',
    rel: 'bots/claude/mcp/claude-dexter-mcp/src/server.ts',
    tools: ['run_checks', 'get_health_summary', 'get_alert_history', 'subscribe_alerts'],
  },
];

const REQUIRED_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'Notification'];
const REQUIRED_HOOK_SCRIPT_FRAGMENTS = [
  'sessionstart-skills-loader',
  'luna-sessionstart-daily-brief',
  'luna-pretooluse-policy-check',
  'posttooluse-systematic-debug',
  'posttooluse-verify',
  'posttooluse-security-scan',
  'posttooluse-hermes-record',
  'posttooluse-pattern-extractor',
  'precompact-skill-refresh',
  'stop-session-wrap',
  'stop-handoff-verify',
  'stop-ticket-status-final',
  'notification-github-issue-update',
  'notification-telegram-alert',
];
const MIN_HOOK_COMMANDS = 19;

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractToolNames(text) {
  const tools = [];
  const re = /name:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(text))) tools.push(match[1]);
  return unique(tools);
}

function flattenHookCommands(hooksJson) {
  const hooks = hooksJson?.hooks || {};
  const commands = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (hook?.type === 'command' && hook.command) {
          commands.push({ event, command: String(hook.command) });
        }
      }
    }
  }
  return commands;
}

function checkMcpServers(root) {
  const servers = REQUIRED_MCP_SERVERS.map((server) => {
    const filePath = path.join(root, server.rel);
    const text = readText(filePath);
    const tools = extractToolNames(text);
    const missingTools = server.tools.filter((tool) => !tools.includes(tool));
    const missingText = (server.requiredText || []).filter((needle) => !text.includes(needle));
    return {
      id: server.id,
      file: filePath,
      exists: Boolean(text),
      toolCount: tools.length,
      requiredToolCount: server.tools.length,
      missingTools,
      missingText,
      ok: Boolean(text) && missingTools.length === 0 && missingText.length === 0,
    };
  });
  return {
    ok: servers.every((server) => server.ok),
    required: REQUIRED_MCP_SERVERS.length,
    count: servers.filter((server) => server.ok).length,
    servers,
  };
}

function checkHookCoverage(root) {
  const hooksPath = path.join(root, '.claude/hooks/hooks.json');
  const hooksJson = readJson(hooksPath);
  const commands = flattenHookCommands(hooksJson);
  const events = unique(commands.map((item) => item.event));
  const missingEvents = REQUIRED_HOOK_EVENTS.filter((event) => !events.includes(event));
  const missingScriptFragments = REQUIRED_HOOK_SCRIPT_FRAGMENTS.filter((fragment) => {
    return !commands.some((item) => item.command.includes(fragment));
  });
  const eventCounts = commands.reduce((acc, item) => {
    acc[item.event] = (acc[item.event] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: Boolean(hooksJson)
      && commands.length >= MIN_HOOK_COMMANDS
      && missingEvents.length === 0
      && missingScriptFragments.length === 0,
    hooksPath,
    commandCount: commands.length,
    minCommandCount: MIN_HOOK_COMMANDS,
    eventCounts,
    missingEvents,
    missingScriptFragments,
  };
}

function checkControlPlanePolicy() {
  const dispatcher = require('./team-dispatcher.ts');
  const sources = [...dispatcher.VALID_HUB_SOURCES].sort();
  return {
    ok: sources.includes('github')
      && sources.includes('telegram')
      && sources.includes('hub')
      && !sources.includes('notion'),
    allowedSources: sources,
    blockedSources: ['notion'],
  };
}

function checkLoopback(root) {
  const hermesSkill = path.join(root, 'bots/claude/a2a/skills/hermes-learn.ts');
  const learningSkill = path.join(root, 'bots/claude/skills/learning-skill/SKILL.md');
  const hooks = checkHookCoverage(root);
  const hasHermesHooks = hooks.missingScriptFragments.includes('posttooluse-hermes-record') === false
    && hooks.missingScriptFragments.includes('posttooluse-pattern-extractor') === false;
  return {
    ok: fs.existsSync(hermesSkill) && fs.existsSync(learningSkill) && hasHermesHooks,
    hermesSkillExists: fs.existsSync(hermesSkill),
    learningSkillExists: fs.existsSync(learningSkill),
    hermesHooksEnabled: hasHermesHooks,
  };
}

function buildPatternReadinessReport(root = path.resolve(__dirname, '../../../..')) {
  const mcp = checkMcpServers(root);
  const hooks = checkHookCoverage(root);
  const controlPlane = checkControlPlanePolicy();
  const loopback = checkLoopback(root);
  const blockers = [];
  const warnings = [];

  if (!mcp.ok) blockers.push('claude_symphony_mcp_pattern_incomplete');
  if (!hooks.ok) blockers.push('claude_hooks_pattern_incomplete');
  if (!controlPlane.ok) blockers.push('control_plane_source_policy_invalid');
  if (!loopback.ok) blockers.push('hermes_loopback_pattern_incomplete');

  return {
    ok: blockers.length === 0,
    status: blockers.length > 0 ? 'claude_luna_pattern_readiness_blocked' : 'claude_luna_pattern_readiness_ready',
    blockers,
    warnings,
    mcp,
    hooks,
    controlPlane,
    loopback,
  };
}

module.exports = {
  REQUIRED_HOOK_SCRIPT_FRAGMENTS,
  REQUIRED_MCP_SERVERS,
  buildPatternReadinessReport,
  checkControlPlanePolicy,
  checkHookCoverage,
  checkLoopback,
  checkMcpServers,
};
