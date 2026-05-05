import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildFinalActivationSummary,
  createDashboardSummary,
} from '../ts/lib/intelligent-library.js';
import { postSigmaAlarmWithRetry, summarizeAlarmResult } from './sigma-alarm-dispatch.js';
import { buildProtectedRuntimeReport } from './sigma-protected-runtime.js';
import { resolveSigmaRuntimeEnv } from './sigma-runtime-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function buildMessage(input: {
  ok: boolean;
  missing: string[];
  dashboardStatus: string;
  protectedMissing: string[];
  warnings: string[];
}): string {
  return [
    `🧭 [SIGMA consistency monitor] ${input.ok ? '정상' : '검토 필요'}`,
    `activation_missing: ${input.missing.length ? input.missing.join(', ') : '0'}`,
    `dashboard: ${input.dashboardStatus}`,
    `protected_missing: ${input.protectedMissing.length ? input.protectedMissing.join(', ') : '0'}`,
    input.warnings.length ? `warnings: ${input.warnings.join(', ')}` : 'warnings: 0',
    'rollback: launchctl setenv SIGMA_V2_ENABLED false',
  ].join('\n');
}

async function main(): Promise<void> {
  const envSource = resolveSigmaRuntimeEnv(repoRoot);
  const activation = buildFinalActivationSummary(envSource.env);
  const dashboard = createDashboardSummary({ env: envSource.env });
  const protectedReport = buildProtectedRuntimeReport();
  const protectedMissing = protectedReport.missing;
  const warnings = [...dashboard.warnings];
  const blockers = [
    ...dashboard.blockers,
    ...activation.missing.map((missing) => `activation_missing:${missing}`),
    ...protectedMissing.map((label) => `protected_label_missing:${label}`),
  ];
  const ok = blockers.length === 0;
  const output = {
    ok,
    status: ok ? 'sigma_consistency_clear' : 'sigma_consistency_blocked',
    generatedAt: new Date().toISOString(),
    activationEnvSource: envSource.source,
    finalActivation: {
      active: activation.active,
      total: activation.total,
      missing: activation.missing,
    },
    dashboardStatus: dashboard.status,
    protectedLabels: {
      total: protectedReport.total,
      missing: protectedMissing,
    },
    blockers,
    warnings,
    rollbackCommand: 'launchctl setenv SIGMA_V2_ENABLED false',
    alertSent: false,
    alertResult: null as unknown,
  };

  if (!ok && (hasArg('--telegram') || process.env.SIGMA_CONSISTENCY_MONITOR_TELEGRAM === 'true')) {
    const dispatch = await postSigmaAlarmWithRetry({
      message: buildMessage({
        ok,
        missing: activation.missing,
        dashboardStatus: dashboard.status,
        protectedMissing,
        warnings,
      }),
      team: 'sigma',
      fromBot: 'sigma-consistency-monitor',
      alertLevel: 4,
      alarmType: 'critical',
      payload: {
        type: 'sigma_consistency_monitor',
        status: output.status,
        rollbackCommand: output.rollbackCommand,
      },
    });
    const result = dispatch.result;
    output.alertSent = Boolean((result as { ok?: boolean } | null)?.ok);
    output.alertResult = summarizeAlarmResult(result);
    (output as Record<string, unknown>).alertAttempts = dispatch.attempts;
  }

  if (hasArg('--json') || !hasArg('--quiet')) {
    console.log(JSON.stringify(output, null, 2));
  }

  if (!ok && hasArg('--strict')) process.exit(1);
}

main().catch((error) => {
  console.error(`[sigma-consistency-monitor] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
