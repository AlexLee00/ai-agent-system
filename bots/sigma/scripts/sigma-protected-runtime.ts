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

export function buildProtectedRuntimeReport(labels = readLaunchctlLabels()): SigmaProtectedRuntimeReport {
  const visible = SIGMA_PROTECTED_LABELS.filter((label) => labels.has(label));
  const missing = SIGMA_PROTECTED_LABELS.filter((label) => !labels.has(label));
  return {
    total: SIGMA_PROTECTED_LABELS.length,
    visible,
    missing,
  };
}
