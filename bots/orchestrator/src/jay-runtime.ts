// @ts-nocheck
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const kst      = require('../../../packages/core/lib/kst');
const pgPool   = require('../../../packages/core/lib/pg-pool');
const sender   = require('../../../packages/core/lib/telegram-sender');
const { getJayOrchestrationConfig } = require('../lib/runtime-config');
const {
  ensureIncidentTables,
  claimQueuedIncident,
  updateIncidentStatus,
  appendIncidentEvent,
} = require('../lib/jay-incident-store');
const {
  ensureJaySkillMemoryTable,
  saveSkillMemory,
  buildSkillContextForPlan,
} = require('../lib/jay-skill-extractor');
const {
  publishMeetingSummary,
  publishTeamProgress,
} = require('../lib/jay-meeting-reporter');
const {
  createControlPlanDraft,
  executeControlPlan,
} = require('../lib/jay-control-plan-client');
const {
  ensureCommanderDispatchTables,
  queueCommanderTask,
  dispatchCommanderQueue,
} = require('../../hub/lib/control/commander-dispatcher');

/**
 * Jay runtime
 *
 * This is the live orchestrator housekeeping loop. The old "mainbot" queue
 * consumer has been retired from runtime; alert fanout now goes through Hub
 * alarm / Telegram topic paths.
 *
 * Responsibilities kept here:
 *   1. flush pending Telegram messages on start
 *   2. send morning summaries for deferred night alerts
 *   3. clean expired mute/confirm state and timed-out bot_commands
 *   4. run periodic commander identity checks
 */

const BOT_NAME = '제이';
const RUNTIME_DIR = process.env.JAY_RUNTIME_DIR
  || process.env.HUB_RUNTIME_DIR
  || path.join(os.homedir(), '.ai-agent-system', 'jay');
const LOCK_PATH = path.join(RUNTIME_DIR, 'jay-runtime.lock');

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function acquireLock() {
  ensureRuntimeDir();
  if (fs.existsSync(LOCK_PATH)) {
    const old = fs.readFileSync(LOCK_PATH, 'utf8').trim();
    try {
      process.kill(Number(old), 0);
      console.error(`${BOT_NAME} runtime already running (PID: ${old})`);
      process.exit(1);
    } catch {
      fs.unlinkSync(LOCK_PATH);
    }
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK_PATH); } catch {} });
  ['SIGTERM', 'SIGINT'].forEach(signal => process.on(signal, () => process.exit(0)));
}

const TG_MAX_LEN = 4096;

function splitMessage(text) {
  if (text.length <= TG_MAX_LEN) return [text];
  const chunks = [];
  const lines  = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    const append = (chunk ? '\n' : '') + line;
    if (chunk.length + append.length > TG_MAX_LEN) {
      if (chunk) chunks.push(chunk);
      if (line.length > TG_MAX_LEN) {
        for (let i = 0; i < line.length; i += TG_MAX_LEN) {
          chunks.push(line.slice(i, i + TG_MAX_LEN));
        }
        chunk = '';
      } else {
        chunk = line;
      }
    } else {
      chunk += append;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

async function sendTelegram(input) {
  const message = typeof input === 'string' ? { text: input } : (input || {});
  const text = String(message.text || '').trim();
  if (!text) return false;
  const topicTeam = normalizeTopicTeam(message.team);

  const chunks = splitMessage(text);
  let allOk = true;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isSingleChunk = chunks.length === 1;
    const ok = isSingleChunk && message.replyMarkup
      ? await sender.sendWithOptions(topicTeam, chunk, {
        replyMarkup: message.replyMarkup,
        disableWebPagePreview: true,
      })
      : await sender.sendBuffered(topicTeam, chunk);
    if (!ok) allOk = false;
    if (chunks.length > 1) await new Promise(resolve => setTimeout(resolve, 1100));
  }
  return allOk;
}

function normalizeTopicTeam(team = 'general') {
  const normalized = String(team || 'general').trim().toLowerCase();
  if (normalized === 'reservation') return 'ska';
  if (normalized === 'investment') return 'luna';
  if (normalized === 'claude') return 'claude-lead';
  return normalized || 'general';
}

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function parseBoolean(value, fallback = false) {
  const text = String(value == null ? (fallback ? 'true' : 'false') : value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(text);
}

function resolveOrchestrationConfig() {
  const runtime = getJayOrchestrationConfig();
  const getBool = (envKey, runtimeKey, fallback = false) => {
    const envValue = process.env[envKey];
    if (envValue != null && String(envValue).trim() !== '') {
      return parseBoolean(envValue, fallback);
    }
    if (typeof runtime?.[runtimeKey] === 'boolean') return runtime[runtimeKey];
    return fallback;
  };
  const getInt = (envKey, runtimeKey, fallback) => {
    const envValue = process.env[envKey];
    if (envValue != null && String(envValue).trim() !== '') {
      const parsed = Number(envValue);
      if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
    }
    const runtimeValue = Number(runtime?.[runtimeKey]);
    if (Number.isFinite(runtimeValue)) return Math.max(1, Math.floor(runtimeValue));
    return fallback;
  };
  return {
    commanderEnabled: getBool('JAY_COMMANDER_ENABLED', 'commanderEnabled', false),
    hubPlanIntegration: getBool('JAY_HUB_PLAN_INTEGRATION', 'hubPlanIntegration', false),
    incidentStoreEnabled: getBool('JAY_INCIDENT_STORE_ENABLED', 'incidentStoreEnabled', false),
    commanderDispatch: getBool('JAY_COMMANDER_DISPATCH', 'commanderDispatch', false),
    teamBusEnabled: getBool('JAY_TEAM_BUS_ENABLED', 'teamBusEnabled', false),
    threeTierTelegram: getBool('JAY_3TIER_TELEGRAM', 'threeTierTelegram', false),
    skillExtraction: getBool('JAY_SKILL_EXTRACTION', 'skillExtraction', false),
    incidentLoopIntervalMs: getInt('JAY_INCIDENT_LOOP_INTERVAL_MS', 'incidentLoopIntervalMs', 5000),
    commanderDispatchLimit: getInt('JAY_COMMANDER_DISPATCH_LIMIT', 'commanderDispatchLimit', 3),
  };
}

async function flushPendingTelegrams() {
  return sender.flushPending();
}

const { cleanExpired: cleanMutes } = require('../lib/mute-manager');
const { cleanExpired: cleanConfirms } = require('../lib/confirm');
const { isBriefingTime, flushMorningQueue, buildMorningBriefingWithOps } = require('../lib/night-handler');
const { runCommanderIdentityCheck, buildIdentityReport } = require('../lib/identity-checker');

let _lastBriefHour = -1;

async function runMorningBriefing() {
  const kstHour = kst.currentHour();
  if (!isBriefingTime(_lastBriefHour)) return;
  _lastBriefHour = kstHour;

  const items = await flushMorningQueue();
  if (items.length === 0) return;

  const brief = await buildMorningBriefingWithOps(items);
  if (brief) await sendTelegram(brief);
}

let _cleanupCounter = 0;

async function runCleanup() {
  _cleanupCounter += 1;
  if (_cleanupCounter % 60 !== 0) return;
  try {
    await cleanMutes();
    await cleanConfirms();
    await pgPool.run('claude', `
      UPDATE bot_commands
      SET status='error',
          result='{"error":"timeout"}',
          done_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE status='pending'
        AND (
          (to_bot = 'claude' AND created_at < to_char(now() - INTERVAL '15 minutes', 'YYYY-MM-DD HH24:MI:SS'))
          OR
          (to_bot <> 'claude' AND created_at < to_char(now() - INTERVAL '5 minutes', 'YYYY-MM-DD HH24:MI:SS'))
        )
    `);
  } catch (error) {
    console.error(`[jay-runtime] cleanup error:`, error.message);
  }
}

let _identityCounter = 0;

async function runIdentityCheck() {
  try {
    const results = runCommanderIdentityCheck();
    const report = buildIdentityReport(results);
    if (report) {
      console.log(`[jay-runtime] commander identity issue detected -> Telegram report`);
      await sendTelegram(report);
    } else {
      console.log(`[jay-runtime] commander identity check OK`);
    }
  } catch (error) {
    console.error(`[jay-runtime] identity check error:`, error.message);
  }
}

let _lastIncidentLoopAt = 0;

function buildIncidentGoal(incident) {
  const fromArgs = incident?.args?.goal || incident?.args?.objective || '';
  if (fromArgs) return String(fromArgs).trim();
  const message = String(incident?.message || '').trim();
  return message || `${incident?.team || 'general'} incident orchestration`;
}

function extractPlanSteps(plan) {
  if (!Array.isArray(plan?.steps)) return [];
  return plan.steps
    .map((step) => ({
      id: String(step?.id || '').trim(),
      tool: String(step?.tool || '').trim(),
      sideEffect: String(step?.sideEffect || 'read_only').trim(),
      args: step?.args && typeof step.args === 'object' ? step.args : {},
      notes: String(step?.notes || '').trim(),
    }))
    .filter((step) => step.id && step.tool);
}

function isMutatingPlanStep(step) {
  return !['none', 'read_only'].includes(String(step?.sideEffect || 'read_only').trim());
}

function isCommanderDelegatedStep(step) {
  return ['write', 'external_mutation', 'money_movement'].includes(String(step?.sideEffect || '').trim());
}

function hasMutatingStep(plan) {
  return extractPlanSteps(plan).some(isMutatingPlanStep);
}

function buildReadOnlyPlan(plan) {
  const readOnlySteps = extractPlanSteps(plan).filter((step) => !isMutatingPlanStep(step));
  return {
    ...plan,
    requiresApproval: false,
    risk: 'low',
    steps: readOnlySteps,
  };
}

async function dispatchMutatingPlanSteps(input) {
  const incident = input?.incident || {};
  const plan = input?.plan || {};
  const flags = input?.flags || {};
  const goal = normalizeText(input?.goal, buildIncidentGoal(incident));
  const incidentKey = normalizeText(incident?.incidentKey, '');
  const steps = extractPlanSteps(plan).filter(isCommanderDelegatedStep);
  if (!steps.length) return { ok: true, dispatched: false, count: 0 };

  if (!flags.teamBusEnabled || !flags.commanderDispatch || !flags.commanderEnabled) {
    return {
      ok: false,
      error: 'commander_dispatch_required_for_mutating_plan',
      count: steps.length,
    };
  }

  const team = String(incident?.team || plan?.team || 'general').trim().toLowerCase();
  for (const step of steps) {
    // eslint-disable-next-line no-await-in-loop
    const queued = await queueCommanderTask({
      incidentKey,
      team,
      stepId: step.id,
      payload: {
        goal,
        planStep: step,
        objective: step.notes || goal,
        incidentIntent: incident.intent,
      },
    });
    if (!queued?.ok) {
      return {
        ok: false,
        error: queued?.error || 'commander_task_queue_failed',
        count: steps.length,
      };
    }
  }

  const dispatch = await dispatchCommanderQueue({
    limit: Math.max(1, Number(flags.commanderDispatchLimit || 3)),
    timeoutMs: 300_000,
    maxRetry: 3,
  });
  const failed = Array.isArray(dispatch?.results)
    ? dispatch.results.filter((result) => !result?.ok)
    : [];
  if (!dispatch?.ok || failed.length > 0) {
    return {
      ok: false,
      error: failed[0]?.error || dispatch?.error || 'commander_dispatch_failed',
      count: steps.length,
      dispatch,
    };
  }

  return {
    ok: true,
    dispatched: true,
    count: steps.length,
    dispatch,
  };
}

async function processIncident(incident, flags) {
  const incidentKey = incident?.incidentKey;
  if (!incidentKey) return { ok: false, error: 'incident_key_required' };

  const goal = buildIncidentGoal(incident);
  await appendIncidentEvent({
    incidentKey,
    eventType: 'jay_runtime_processing_started',
    payload: {
      team: incident.team,
      intent: incident.intent,
      goal,
    },
  }).catch(() => {});

  if (flags.threeTierTelegram) {
    await publishMeetingSummary({
      incidentKey,
      phase: 'frame',
      team: incident.team,
      title: incident.intent,
      summary: goal,
    }).catch(() => {});
  }

  let skillContext = '';
  if (flags.skillExtraction) {
    const skillContextResult = await buildSkillContextForPlan({
      team: incident.team,
      strategyKey: `${incident.team}:${incident.intent}`,
      limit: 5,
      days: 45,
    }).catch(() => null);
    if (skillContextResult?.ok && skillContextResult.context) {
      skillContext = skillContextResult.context;
      await appendIncidentEvent({
        incidentKey,
        eventType: 'jay_skill_context_attached',
        payload: {
          skillCount: Array.isArray(skillContextResult.skills) ? skillContextResult.skills.length : 0,
        },
      }).catch(() => {});
    }
  }

  const planResponse = await createControlPlanDraft({
    message: skillContext ? `${goal}\n\n${skillContext}` : goal,
    goal,
    team: incident.team,
    dryRun: true,
    timeoutMs: 20_000,
    retries: 1,
  });
  if (!planResponse?.ok) {
    await updateIncidentStatus({
      incidentKey,
      status: 'failed',
      lastError: planResponse?.error || 'control_plan_failed',
    });
    return { ok: false, error: planResponse?.error || 'control_plan_failed' };
  }

  const plan = planResponse.payload?.plan || {};
  const runId = String(planResponse.payload?.run_id || '').trim() || null;
  await updateIncidentStatus({
    incidentKey,
    status: 'planned',
    runId,
    plan,
  });

  if (flags.threeTierTelegram) {
    await publishMeetingSummary({
      incidentKey,
      phase: 'plan',
      team: incident.team,
      title: incident.intent,
      summary: `run=${runId || '-'} steps=${extractPlanSteps(plan).length}`,
    }).catch(() => {});
  }

  const approvalRequired = Boolean(planResponse.payload?.approval?.required);
  if (approvalRequired) {
    await updateIncidentStatus({
      incidentKey,
      status: 'awaiting_approval',
      runId,
      plan,
    });
    return {
      ok: true,
      pendingApproval: true,
      runId,
      planStepCount: extractPlanSteps(plan).length,
    };
  }

  const mutating = hasMutatingStep(plan);
  const commanderResult = await dispatchMutatingPlanSteps({
    incident,
    plan,
    flags,
    goal,
  });
  if (!commanderResult?.ok) {
    await updateIncidentStatus({
      incidentKey,
      status: 'failed',
      runId,
      plan,
      lastError: commanderResult?.error || 'commander_dispatch_failed',
    });
    return { ok: false, error: commanderResult?.error || 'commander_dispatch_failed' };
  }

  const readOnlyPlan = mutating ? buildReadOnlyPlan(plan) : plan;
  const readOnlySteps = extractPlanSteps(readOnlyPlan);
  let executeResponse = { ok: true, skipped: true, reason: 'no_read_only_steps', payload: { result: [] } };
  if (readOnlySteps.length > 0) {
    executeResponse = await executeControlPlan({
      runId: mutating ? null : runId,
      plan: mutating ? readOnlyPlan : undefined,
      timeoutMs: 20_000,
      retries: 1,
    });
  }
  if (!executeResponse?.ok) {
    await updateIncidentStatus({
      incidentKey,
      status: 'failed',
      runId,
      plan,
      lastError: executeResponse?.error || 'control_execute_failed',
    });
    return { ok: false, error: executeResponse?.error || 'control_execute_failed' };
  }

  if (flags.skillExtraction) {
    await saveSkillMemory({
      incidentKey,
      team: incident.team,
      strategyKey: `${incident.team}:${incident.intent}`,
      summary: `goal=${goal} / steps=${extractPlanSteps(plan).length} / execute=ok`,
      evidence: {
        runId,
        planStepCount: extractPlanSteps(plan).length,
      },
      outcomeStatus: 'completed',
      confidence: 0.65,
    }).catch((error) => {
      console.warn(`[jay-runtime] skill save warning: ${error?.message || error}`);
    });
  }

  await updateIncidentStatus({
    incidentKey,
    status: 'completed',
    runId,
    plan,
  });

  if (flags.threeTierTelegram) {
    await publishMeetingSummary({
      incidentKey,
      phase: 'final',
      team: incident.team,
      title: incident.intent,
      summary: `run=${runId || '-'} completed`,
    }).catch(() => {});
    await publishTeamProgress({
      incidentKey,
      team: incident.team,
      status: 'completed',
      message: `orchestration complete (${incident.intent})`,
    }).catch(() => {});
  }

  return {
    ok: true,
    runId,
    planStepCount: extractPlanSteps(plan).length,
    mutating,
    commanderDispatched: Boolean(commanderResult?.dispatched),
  };
}

async function runIncidentLoop() {
  const flags = resolveOrchestrationConfig();
  if (!flags.incidentStoreEnabled || !flags.hubPlanIntegration) return;
  const now = Date.now();
  if (now - _lastIncidentLoopAt < flags.incidentLoopIntervalMs) return;
  _lastIncidentLoopAt = now;

  const incident = await claimQueuedIncident().catch((error) => {
    console.warn(`[jay-runtime] claim incident failed: ${error?.message || error}`);
    return null;
  });
  if (!incident) return;

  const result = await processIncident(incident, flags).catch(async (error) => {
    const errorMessage = String(error?.message || error || 'incident_process_failed');
    await updateIncidentStatus({
      incidentKey: incident.incidentKey,
      status: 'failed',
      lastError: errorMessage,
    }).catch(() => {});
    return { ok: false, error: errorMessage };
  });

  if (!result?.ok) {
    console.warn(`[jay-runtime] incident failed: ${incident.incidentKey} (${result?.error || 'unknown'})`);
  }
}

async function mainLoop() {
  await runMorningBriefing();
  await runCleanup();
  await runIncidentLoop();

  _identityCounter += 1;
  if (_identityCounter % 10800 === 30) await runIdentityCheck();
}

async function main() {
  acquireLock();
  await flushPendingTelegrams();
  const flags = resolveOrchestrationConfig();
  if (flags.incidentStoreEnabled) {
    await ensureIncidentTables().catch((error) => {
      throw new Error(`incident_table_init_failed:${error?.message || error}`);
    });
  }
  if (flags.teamBusEnabled && flags.commanderDispatch) {
    await ensureCommanderDispatchTables().catch((error) => {
      throw new Error(`commander_dispatch_table_init_failed:${error?.message || error}`);
    });
  }
  if (flags.skillExtraction) {
    await ensureJaySkillMemoryTable().catch((error) => {
      throw new Error(`skill_memory_init_failed:${error?.message || error}`);
    });
  }

  console.log(`🤖 ${BOT_NAME} runtime started (PID: ${process.pid}, lock: ${LOCK_PATH})`);

  while (true) {
    try {
      await mainLoop();
    } catch (error) {
      console.error(`[jay-runtime] loop error:`, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main().catch(error => {
  console.error(`[jay-runtime] fatal error:`, error);
  process.exit(1);
});
