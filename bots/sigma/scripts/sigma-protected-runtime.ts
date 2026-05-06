import { execFileSync } from 'node:child_process';

export const SIGMA_PROTECTED_LABELS = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.luna.marketdata-mcp',
  'ai.claude.auto-dev.autonomous',
  'ai.hub.resource-api',
] as const;

export type SigmaProtectedRuntimeReport = {
  total: number;
  missing: string[];
  visible: string[];
};

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

export function getProtectedLabels(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  if (isTruthy(env.CLAUDE_AUTO_DEV_DISABLED)) {
    return SIGMA_PROTECTED_LABELS.filter((label) => label !== 'ai.claude.auto-dev.autonomous');
  }
  return SIGMA_PROTECTED_LABELS;
}

export function readLaunchctlLabels(): Set<string> {
  try {
    const output = execFileSync('/bin/launchctl', ['list'], { encoding: 'utf8' });
    const labels = new Set<string>();
    for (const line of output.split('\n')) {
      const label = line.trim().split(/\s+/).at(-1);
      if (label) labels.add(label);
    }
    return labels;
  } catch {
    return new Set();
  }
}

export function buildProtectedRuntimeReport(
  labels = readLaunchctlLabels(),
  env: NodeJS.ProcessEnv = process.env,
): SigmaProtectedRuntimeReport {
  const protectedLabels = getProtectedLabels(env);
  const visible = protectedLabels.filter((label) => labels.has(label));
  const missing = protectedLabels.filter((label) => !labels.has(label));
  return {
    total: protectedLabels.length,
    visible,
    missing,
  };
}
