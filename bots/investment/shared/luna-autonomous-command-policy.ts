// @ts-nocheck

export const LUNA_AUTONOMOUS_BLOCKED_COMMAND_PATTERNS = Object.freeze([
  {
    id: 'launchctl_setenv',
    pattern: /\blaunchctl\s+setenv\b/i,
    reason: 'runtime env mutation requires master approval',
  },
  {
    id: 'plist_edit',
    pattern: /\bPlistBuddy\b[\s\S]*\b(?:Add|Set|Delete|Clear|Merge|Import)\b[\s\S]*\.plist\b|\bplutil\b(?=[\s\S]*\.plist\b)(?=[\s\S]*\b(?:-replace|-remove|-insert|-create)\b)|\b(?:sed|perl)\b(?=[\s\S]*\s-i\b)(?=[\s\S]*\.plist\b)|\bpython3?\b(?=[\s\S]*\.plist\b)(?=[\s\S]*\b(?:write|dump|replace|remove|insert)\b)/i,
    reason: 'launchd plist mutation requires master approval',
  },
  {
    id: 'runtime_config_force_apply',
    pattern: /\bapply-runtime-config-suggestion\b[\s\S]*\s--force\b/i,
    reason: 'forced runtime-config apply is master runbook only',
  },
]);

export function evaluateLunaAutonomousCommand(command: unknown) {
  const text = Array.isArray(command) ? command.join(' ') : String(command || '');
  const match = LUNA_AUTONOMOUS_BLOCKED_COMMAND_PATTERNS.find((item) => item.pattern.test(text));
  return {
    ok: !match,
    blocked: Boolean(match),
    reason: match?.id || null,
    detail: match?.reason || null,
    command: text,
  };
}

export function assertLunaAutonomousCommandAllowed(command: unknown) {
  const result = evaluateLunaAutonomousCommand(command);
  if (!result.ok) {
    throw new Error(`luna_autonomous_command_blocked:${result.reason}`);
  }
  return result;
}

export default {
  LUNA_AUTONOMOUS_BLOCKED_COMMAND_PATTERNS,
  evaluateLunaAutonomousCommand,
  assertLunaAutonomousCommandAllowed,
};
