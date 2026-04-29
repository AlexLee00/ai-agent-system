#!/usr/bin/env node
// @ts-nocheck

import { spawnSync } from 'node:child_process';
import { buildPosttradeFeedbackDoctor } from './runtime-posttrade-feedback-doctor.ts';
import { runPosttradeFeedbackReadiness } from './runtime-posttrade-feedback-readiness.ts';
import { buildPosttradeFeedbackL5Gate } from './runtime-posttrade-feedback-l5-gate.ts';
import { buildPosttradeFeedbackPhasePlan } from './runtime-posttrade-feedback-phase-operator.ts';
import { buildPosttradeFeedbackDashboard } from './runtime-posttrade-feedback-dashboard.ts';
import { buildPosttradeFeedbackActionStaging } from './runtime-posttrade-feedback-action-staging.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const LAUNCHD_LABEL = 'ai.investment.posttrade-feedback-worker';

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    json: argv.includes('--json'),
    telegram: argv.includes('--telegram'),
    strict: argv.includes('--strict'),
    days: Math.max(1, Number(daysRaw || 7) || 7),
    market: String(market || 'all').trim().toLowerCase() || 'all',
  };
}

function inspectLaunchdService() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const domain = uid == null ? 'gui/unknown' : `gui/${uid}`;
  const proc = spawnSync('launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const text = `${proc.stdout || ''}\n${proc.stderr || ''}`;
  const loaded = proc.status === 0;
  const pidMatch = text.match(/\bpid\s*=\s*(\d+)/);
  const lastExitMatch = text.match(/\blast exit code\s*=\s*(-?\d+)/i);
  const runIntervalMatch = text.match(/\brun interval\s*=\s*(\d+)\s*seconds/i);
  return {
    ok: loaded,
    loaded,
    label: LAUNCHD_LABEL,
    domain,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    lastExitCode: lastExitMatch ? Number(lastExitMatch[1]) : null,
    runIntervalSec: runIntervalMatch ? Number(runIntervalMatch[1]) : null,
    status: loaded ? 'launchd_loaded' : 'launchd_not_loaded',
    detail: loaded ? null : text.slice(-500).trim(),
  };
}

function chooseNextAction({ cfg, doctor, readiness, gate, phasePlan, launchd } = {}) {
  if (doctor?.ok !== true) return 'repair_posttrade_doctor_failures';
  if (readiness?.ok !== true) return 'repair_posttrade_readiness_blockers';
  if (phasePlan?.ok === true && phasePlan.steps?.some((step) => step.currentlyEnabled !== true)) {
    return 'enable_remaining_posttrade_phases';
  }
  if (cfg?.worker?.enabled === true && launchd?.loaded !== true) return 'load_posttrade_feedback_worker_launchd';
  if (gate?.ok !== true) return 'resolve_posttrade_l5_gate_blockers';
  return 'continue_posttrade_operational_observation';
}

export async function buildPosttradeFeedbackOperatingReport({
  days = 7,
  market = 'all',
  strict = false,
} = {}) {
  const cfg = getPosttradeFeedbackRuntimeConfig();
  const autoApplyEnabled = cfg?.parameter_feedback_map?.auto_apply === true;
  const [doctor, readiness, gate, phasePlan, dashboard, actionStaging] = await Promise.all([
    buildPosttradeFeedbackDoctor({ strict: false }),
    runPosttradeFeedbackReadiness({ strict: false, market, limit: 3 }).catch((error) => ({
      ok: false,
      blockers: [`readiness_failed:${error?.message || String(error)}`],
    })),
    buildPosttradeFeedbackL5Gate({ strict: false }).catch((error) => ({
      ok: false,
      blockers: [`l5_gate_failed:${error?.message || String(error)}`],
    })),
    Promise.resolve(buildPosttradeFeedbackPhasePlan({
      requestedPhase: 'all',
      mode: cfg?.mode || 'shadow',
      autoApply: autoApplyEnabled,
    })),
    buildPosttradeFeedbackDashboard({ days, market }).catch((error) => ({
      ok: false,
      code: 'dashboard_failed',
      error: String(error?.message || error || 'unknown'),
    })),
    buildPosttradeFeedbackActionStaging({ days: 30, limit: 100 }).catch((error) => ({
      ok: false,
      error: String(error?.message || error || 'unknown'),
    })),
  ]);
  const launchd = inspectLaunchdService();
  const blockers = [
    ...(doctor?.ok === true ? [] : ['doctor_failed']),
    ...(readiness?.ok === true ? [] : ['readiness_blocked']),
    ...(gate?.ok === true ? [] : ['l5_gate_blocked']),
    ...(strict && cfg?.worker?.enabled === true && launchd.loaded !== true ? ['launchd_worker_not_loaded'] : []),
  ];
  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'posttrade_feedback_operational' : 'posttrade_feedback_attention',
    blockers,
    nextAction: chooseNextAction({ cfg, doctor, readiness, gate, phasePlan, launchd }),
    config: {
      mode: cfg?.mode || 'shadow',
      tradeQualityEnabled: cfg?.trade_quality?.enabled === true,
      stageAttributionEnabled: cfg?.stage_attribution?.enabled === true,
      reflexionEnabled: cfg?.reflexion?.enabled === true,
      skillExtractionEnabled: cfg?.skill_extraction?.enabled === true,
      actionMapEnabled: cfg?.parameter_feedback_map?.enabled === true,
      actionAutoApply: autoApplyEnabled,
      constitutionEnabled: cfg?.constitutional_feedback?.enabled === true,
      marketDifferentiatedEnabled: cfg?.market_differentiated?.enabled === true,
      dashboardEnabled: cfg?.dashboard?.enabled === true,
      workerEnabled: cfg?.worker?.enabled === true,
      workerIntervalSec: cfg?.worker?.interval_sec || null,
    },
    doctor: {
      ok: doctor?.ok === true,
      failures: doctor?.failures || [],
      warnings: doctor?.warnings || [],
    },
    readiness: {
      ok: readiness?.ok === true,
      blockers: readiness?.blockers || [],
      nextAction: readiness?.nextAction || null,
    },
    gate: {
      ok: gate?.ok === true,
      blockers: gate?.blockers || [],
      actionStaging: gate?.actionStaging || null,
    },
    phasePlan: {
      ok: phasePlan?.ok === true,
      disabledPhases: (phasePlan?.steps || []).filter((step) => step.currentlyEnabled !== true).map((step) => step.phase),
      blockers: phasePlan?.blockers || [],
      nextCommand: phasePlan?.ok
        ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:posttrade-feedback-phase-operate -- --phase=all --mode=${cfg?.mode || 'shadow'}${autoApplyEnabled ? ' --auto-apply' : ''} --apply --confirm=luna-posttrade-feedback-operate --run-smoke --rollback-on-fail --json`
        : null,
    },
    launchd,
    dashboard: {
      ok: dashboard?.ok === true,
      status: dashboard?.status || dashboard?.code || 'unknown',
      totalEvaluations: dashboard?.summary?.totalEvaluations ?? dashboard?.totalEvaluations ?? null,
      constitution: dashboard?.constitution || null,
    },
    actionStaging: {
      ok: actionStaging?.ok === true,
      patchCount: actionStaging?.patchCount || 0,
      rejectedCount: actionStaging?.rejectedCount || 0,
      requiresApproval: actionStaging?.requiresApproval === true,
    },
  };
}

export function renderPosttradeFeedbackOperatingReport(report = {}) {
  return [
    '🌙 Luna posttrade feedback operating report',
    `status: ${report.status || 'unknown'} / next=${report.nextAction || 'unknown'}`,
    `mode: ${report.config?.mode || 'unknown'} / worker=${report.config?.workerEnabled === true} / interval=${report.config?.workerIntervalSec ?? 'n/a'}s`,
    `phases: quality=${report.config?.tradeQualityEnabled === true} attribution=${report.config?.stageAttributionEnabled === true} reflexion=${report.config?.reflexionEnabled === true} skills=${report.config?.skillExtractionEnabled === true} action=${report.config?.actionMapEnabled === true} constitution=${report.config?.constitutionEnabled === true} market=${report.config?.marketDifferentiatedEnabled === true} dashboard=${report.config?.dashboardEnabled === true}`,
    `doctor: ok=${report.doctor?.ok === true} / failures=${(report.doctor?.failures || []).length} / warnings=${(report.doctor?.warnings || []).length}`,
    `readiness: ok=${report.readiness?.ok === true} / blockers=${(report.readiness?.blockers || []).length}`,
    `gate: ok=${report.gate?.ok === true} / blockers=${(report.gate?.blockers || []).length}`,
    `launchd: ${report.launchd?.status || 'unknown'} / pid=${report.launchd?.pid ?? 'n/a'} / interval=${report.launchd?.runIntervalSec ?? 'n/a'}s / lastExit=${report.launchd?.lastExitCode ?? 'n/a'}`,
    `action staging: patches=${report.actionStaging?.patchCount ?? 0} rejected=${report.actionStaging?.rejectedCount ?? 0}`,
    `disabled phases: ${(report.phasePlan?.disabledPhases || []).join(',') || 'none'}`,
    `blockers: ${(report.blockers || []).join(' / ') || 'none'}`,
  ].join('\n');
}

export async function publishPosttradeFeedbackOperatingReport(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderPosttradeFeedbackOperatingReport(report),
    payload: {
      generatedAt: report.generatedAt,
      status: report.status,
      blockers: report.blockers,
      nextAction: report.nextAction,
      config: report.config,
      launchd: report.launchd,
      readiness: report.readiness,
      gate: report.gate,
      actionStaging: report.actionStaging,
    },
  });
}

async function main() {
  const args = parseArgs();
  const report = await buildPosttradeFeedbackOperatingReport(args);
  if (args.telegram) await publishPosttradeFeedbackOperatingReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.telegram) console.log(renderPosttradeFeedbackOperatingReport(report));
  if (args.strict && report.ok !== true) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-operating-report 실패:',
  });
}
