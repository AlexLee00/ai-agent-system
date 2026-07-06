#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * edux-launchd-doctor.ts
 *
 * Audits and optionally bootstraps/reloads the eight Edu-X LaunchAgents.
 * Dry-run apply only loads missing agents after every plist proves safe
 * dry-run flags. Live apply requires an explicit live confirm token and a
 * promotion gate report by default. Set EDUX_REQUIRE_PROMOTION_GATE=false only
 * after master-approved gate relaxation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');
const LAUNCHD_DIR = path.join(EDUX_ROOT, 'launchd');
const OUTPUT_DIR = path.join(EDUX_ROOT, 'output');
const REPORT_PATH = path.join(OUTPUT_DIR, 'edux-launchd-doctor.json');
const PROMOTION_GATE_REPORT = path.join(OUTPUT_DIR, 'edux-promotion-gate.json');
const DRY_RUN_CONFIRM_TOKEN = 'edux-launchd-dry-run';
const LIVE_CONFIRM_TOKEN = 'edux-launchd-live';
const LABEL_PREFIX = 'ai.edux.';
const EXPECTED_COUNT = 8;
const PROMOTION_GATE_REQUIRED_CHECKS = 7;
const PROMOTION_GATE_MAX_AGE_MS = 24 * 3600 * 1000;

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function envRequiresPromotionGate(envVars = process.env) {
  return String(envVars.EDUX_REQUIRE_PROMOTION_GATE || '').trim().toLowerCase() !== 'false';
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    confirm: null,
    json: false,
    noWrite: false,
    strict: false,
    mode: process.env.EDUX_LAUNCHD_MODE || 'auto',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--apply') args.apply = true;
    else if (item === '--json') args.json = true;
    else if (item === '--no-write') args.noWrite = true;
    else if (item === '--strict') args.strict = true;
    else if (item === '--live') args.mode = 'live';
    else if (item === '--dry-run') args.mode = 'dry-run';
    else if (item === '--mode' && argv[i + 1]) args.mode = argv[++i];
    else if (item.startsWith('--mode=')) args.mode = item.split('=', 2)[1];
    else if (item === '--confirm' && argv[i + 1]) args.confirm = argv[++i];
    else if (item.startsWith('--confirm=')) args.confirm = item.split('=', 2)[1];
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? result.error.message : null,
  };
}

function readPlist(filePath) {
  const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filePath]);
  if (!result.ok) throw new Error(result.stderr || result.error || `plutil failed: ${filePath}`);
  return JSON.parse(result.stdout);
}

function listPlists() {
  if (!fs.existsSync(LAUNCHD_DIR)) return [];
  return fs.readdirSync(LAUNCHD_DIR)
    .filter((name) => /^ai\.edux\..+\.plist$/.test(name))
    .sort()
    .map((name) => path.join(LAUNCHD_DIR, name));
}

function launchTarget() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : Number(run('/usr/bin/id', ['-u']).stdout);
  return `gui/${uid}`;
}

function destinationFor(filePath) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', path.basename(filePath));
}

function isLoaded(label) {
  const target = launchTarget();
  const printed = run('/bin/launchctl', ['print', `${target}/${label}`]);
  if (printed.ok) return true;
  const listed = run('/bin/launchctl', ['list', label]);
  return listed.ok;
}

function sameFileContent(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
}

function normalizeMode(mode) {
  const value = String(mode || 'auto').trim().toLowerCase();
  if (['live', 'production', 'prod'].includes(value)) return 'live';
  if (['dry-run', 'dry_run', 'dryrun', 'shadow'].includes(value)) return 'dry-run';
  return 'auto';
}

function detectRuntimeMode(envVars = {}) {
  if (
    envVars.EDUX_DRY_RUN === 'true'
    && envVars.EDUX_LIVE_PUBLISH_APPROVED === 'false'
    && (!envRequiresPromotionGate(envVars) || envVars.EDUX_PROMOTION_GATE_PASSED === 'false')
  ) return 'dry-run';
  if (
    envVars.EDUX_DRY_RUN === 'false'
    && envVars.EDUX_LIVE_PUBLISH_APPROVED === 'true'
    && (!envRequiresPromotionGate(envVars) || envVars.EDUX_PROMOTION_GATE_PASSED === 'true')
  ) return 'live';
  return 'invalid';
}

function detectDigestRuntimeMode(envVars = {}) {
  const value = String(envVars.EDUX_DIGEST_DRY_RUN || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return 'dry-run';
  if (['false', '0', 'no', 'off'].includes(value)) return 'live';
  return 'invalid';
}

function programArgDetails(programArgs = []) {
  let envFilePath = '';
  let runtimePath = '';
  for (let i = 1; i < programArgs.length; i += 1) {
    const item = String(programArgs[i] || '');
    if (item.startsWith('--env-file=')) {
      envFilePath = item.slice('--env-file='.length);
      continue;
    }
    if (item === '--env-file') {
      envFilePath = String(programArgs[i + 1] || '');
      i += 1;
      continue;
    }
    if (!item.startsWith('-') && /\.(?:c?js|mjs|tsx?|mts|cts)$/.test(item)) {
      runtimePath = item;
    }
  }
  return {
    nodePath: String(programArgs[0] || ''),
    envFilePath,
    runtimePath,
  };
}

function isDailyDigestJob(label = '', programArgs = []) {
  const details = programArgDetails(programArgs);
  return label === 'ai.edux.daily-digest'
    || /runtime-edux-daily-digest\.ts$/.test(details.runtimePath);
}

function runtimeModeForPlist(label = '', programArgs = [], envVars = {}) {
  return isDailyDigestJob(label, programArgs)
    ? detectDigestRuntimeMode(envVars)
    : detectRuntimeMode(envVars);
}

function loadPromotionGateReport() {
  try {
    if (!fs.existsSync(PROMOTION_GATE_REPORT)) return null;
    return JSON.parse(fs.readFileSync(PROMOTION_GATE_REPORT, 'utf8'));
  } catch {
    return null;
  }
}

function promotionGateReportBlockingReasons(report) {
  const reasons = [];
  if (!report?.allPass) reasons.push('promotion gate report is missing or not PASS');
  if (report?.fixture || report?.mode === 'fixture') reasons.push('promotion gate report is fixture-only');
  if (!Array.isArray(report?.checks) || report.checks.length < PROMOTION_GATE_REQUIRED_CHECKS) {
    reasons.push(`promotion gate report has fewer than ${PROMOTION_GATE_REQUIRED_CHECKS} checks`);
  }
  const generatedAt = report?.generatedAt ? Date.parse(report.generatedAt) : NaN;
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > PROMOTION_GATE_MAX_AGE_MS) {
    reasons.push('promotion gate report is stale');
  }
  return reasons;
}

function livePromotionGateReady() {
  const report = loadPromotionGateReport();
  const blockingReasons = promotionGateReportBlockingReasons(report);
  return {
    ok: blockingReasons.length === 0,
    report: report ? {
      generatedAt: report.generatedAt || null,
      mode: report.mode || null,
      fixture: Boolean(report.fixture),
      summary: report.summary || null,
      allPass: Boolean(report.allPass),
      checkCount: Array.isArray(report.checks) ? report.checks.length : 0,
      blockingReasons,
    } : null,
    blockingReasons,
  };
}

function confirmTokenFor(mode) {
  return mode === 'live' ? LIVE_CONFIRM_TOKEN : DRY_RUN_CONFIRM_TOKEN;
}

function validatePlist(filePath, plist, requestedMode = 'auto') {
  const issues = [];
  const label = String(plist.Label || '');
  const envVars = plist.EnvironmentVariables || {};
  const programArgs = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const calendar = plist.StartCalendarInterval || {};
  const programArgsInfo = programArgDetails(programArgs);
  const mode = runtimeModeForPlist(label, programArgs, envVars);
  const expectedMode = normalizeMode(requestedMode);
  const imageAttachmentsEnabled = String(envVars.EDUX_IMAGE_ATTACHMENTS_ENABLED || 'false') === 'true';

  if (!label.startsWith(LABEL_PREFIX)) issues.push('label_not_ai_edux');
  if (!path.basename(filePath).startsWith(`${label}.`)) issues.push('filename_label_mismatch');
  if (mode === 'invalid') issues.push('edux_runtime_flags_invalid');
  if (expectedMode !== 'auto' && mode !== expectedMode) issues.push(`edux_runtime_mode_not_${expectedMode}`);
  if (imageAttachmentsEnabled) issues.push('image_attachments_enabled');
  if (plist.RunAtLoad !== false) issues.push('RunAtLoad_not_false');
  if (plist.KeepAlive !== false) issues.push('KeepAlive_not_false');
  if (!Number.isInteger(calendar.Hour) || !Number.isInteger(calendar.Minute)) issues.push('StartCalendarInterval_missing');
  if (programArgs.length < 2) issues.push('ProgramArguments_incomplete');
  if (programArgsInfo.nodePath && !fs.existsSync(programArgsInfo.nodePath)) issues.push(`node_missing:${programArgsInfo.nodePath}`);
  if (programArgsInfo.envFilePath && !fs.existsSync(programArgsInfo.envFilePath)) issues.push(`env_file_missing:${programArgsInfo.envFilePath}`);
  if (!programArgsInfo.runtimePath) issues.push('runtime_missing');
  else if (!fs.existsSync(programArgsInfo.runtimePath)) issues.push(`runtime_missing:${programArgsInfo.runtimePath}`);

  return issues;
}

function copyPlist(source, destination, apply) {
  const existedBefore = fs.existsSync(destination);
  const inSyncBefore = sameFileContent(source, destination);
  if (inSyncBefore) {
    return { action: 'unchanged', path: destination, existedBefore, inSyncBefore, inSyncAfter: true };
  }
  if (!apply) {
    return {
      action: existedBefore ? 'would_update' : 'would_copy',
      path: destination,
      existedBefore,
      inSyncBefore,
      inSyncAfter: false,
    };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const inSyncAfter = sameFileContent(source, destination);
  return {
    action: inSyncAfter ? (existedBefore ? 'updated' : 'copied') : 'copy_failed',
    path: destination,
    existedBefore,
    inSyncBefore,
    inSyncAfter,
  };
}

function bootstrapPlist(label, destination, apply, loadedBefore = isLoaded(label)) {
  if (loadedBefore) return { action: 'already_loaded', loadedBefore, loadedAfter: true };
  if (!apply) return { action: 'would_bootstrap', loadedBefore, loadedAfter: false };

  const result = run('/bin/launchctl', ['bootstrap', launchTarget(), destination]);
  const enableResult = run('/bin/launchctl', ['enable', `${launchTarget()}/${label}`]);
  const loadedAfter = isLoaded(label);
  return {
    action: loadedAfter ? 'bootstrapped' : 'bootstrap_failed',
    loadedBefore,
    loadedAfter,
    bootstrapStatus: result.status,
    bootstrapError: result.ok ? null : (result.stderr || result.error || result.stdout),
    enableStatus: enableResult.status,
    enableError: enableResult.ok ? null : (enableResult.stderr || enableResult.error || enableResult.stdout),
  };
}

function reloadPlist(label, destination, apply, reloadNeeded) {
  if (!reloadNeeded) return null;
  if (!apply) return { action: 'would_reload', loadedAfter: isLoaded(label) };

  const target = launchTarget();
  const bootout = run('/bin/launchctl', ['bootout', target, destination]);
  const bootstrap = run('/bin/launchctl', ['bootstrap', target, destination]);
  const enable = run('/bin/launchctl', ['enable', `${target}/${label}`]);
  const loadedAfter = isLoaded(label);
  return {
    action: loadedAfter ? 'reloaded' : 'reload_failed',
    loadedAfter,
    bootoutStatus: bootout.status,
    bootoutError: bootout.ok ? null : (bootout.stderr || bootout.error || bootout.stdout),
    bootstrapStatus: bootstrap.status,
    bootstrapError: bootstrap.ok ? null : (bootstrap.stderr || bootstrap.error || bootstrap.stdout),
    enableStatus: enable.status,
    enableError: enable.ok ? null : (enable.stderr || enable.error || enable.stdout),
  };
}

function buildReport(args) {
  const mode = normalizeMode(args.mode);
  const promotionGateRequired = envRequiresPromotionGate();
  const liveGate = mode === 'live' && promotionGateRequired ? livePromotionGateReady() : null;
  const applyModeExplicit = mode !== 'auto';
  const expectedConfirm = applyModeExplicit ? confirmTokenFor(mode) : null;
  const plists = listPlists();
  const sources = plists.map((filePath) => {
    const plist = readPlist(filePath);
    const label = String(plist.Label || path.basename(filePath, '.plist'));
    const issues = validatePlist(filePath, plist, mode);
    const destination = destinationFor(filePath);
    return { filePath, plist, label, issues, destination };
  });
  const preflightValidationFailures = sources.filter((source) => source.issues.length > 0);
  const sourceSetSafe = plists.length === EXPECTED_COUNT && preflightValidationFailures.length === 0;
  const confirmOk = applyModeExplicit
    && args.confirm === expectedConfirm
    && (mode !== 'live' || !promotionGateRequired || liveGate?.ok === true);
  const allowApply = Boolean(args.apply && confirmOk && sourceSetSafe);
  const applyRejected = Boolean(args.apply && !allowApply);
  const entries = sources.map(({ filePath, plist, label, issues, destination }) => {
    const safeToApply = issues.length === 0;
    const loadedBefore = isLoaded(label);
    const copy = safeToApply ? copyPlist(filePath, destination, allowApply) : { action: 'blocked_by_validation', path: destination };
    const reloadNeeded = safeToApply && loadedBefore && copy.inSyncBefore === false;
    const reload = safeToApply ? reloadPlist(label, destination, allowApply, reloadNeeded) : null;
    const bootstrap = safeToApply && !reloadNeeded ? bootstrapPlist(label, destination, allowApply, loadedBefore) : { action: reloadNeeded ? 'handled_by_reload' : 'blocked_by_validation', loadedAfter: isLoaded(label) };
    const loaded = isLoaded(label);
    const reloadRequired = safeToApply && loadedBefore && copy.inSyncBefore === false && !(allowApply && reload && reload.loadedAfter);
    return {
      label,
      source: filePath,
      destination,
      schedule: plist.StartCalendarInterval || null,
      dryRun: plist.EnvironmentVariables?.EDUX_DRY_RUN || null,
      liveApproved: plist.EnvironmentVariables?.EDUX_LIVE_PUBLISH_APPROVED || null,
      promotionGatePassed: plist.EnvironmentVariables?.EDUX_PROMOTION_GATE_PASSED || null,
      digestDryRun: plist.EnvironmentVariables?.EDUX_DIGEST_DRY_RUN || null,
      digestTelegramTarget: plist.EnvironmentVariables?.EDUX_DIGEST_TELEGRAM_TARGET || null,
      imageAttachmentsEnabled: plist.EnvironmentVariables?.EDUX_IMAGE_ATTACHMENTS_ENABLED || null,
      runtimeMode: runtimeModeForPlist(label, plist.ProgramArguments || [], plist.EnvironmentVariables || {}),
      validationIssues: issues,
      copy,
      bootstrap,
      reload,
      loadedBefore,
      loaded,
      reloadRequired,
      runtimeConfigStatus: reloadRequired ? 'reload_required' : (loaded ? 'loaded_current_plist' : 'not_loaded'),
    };
  });

  const validationFailures = entries.filter((entry) => entry.validationIssues.length > 0);
  const missing = entries.filter((entry) => !entry.loaded).map((entry) => entry.label);
  const reloadRequired = entries.filter((entry) => entry.reloadRequired).map((entry) => entry.label);
  const loadedCount = entries.filter((entry) => entry.loaded).length;
  const ok = plists.length === EXPECTED_COUNT
    && validationFailures.length === 0
    && missing.length === 0
    && reloadRequired.length === 0
    && (mode !== 'live' || !promotionGateRequired || liveGate?.ok === true)
    && !applyRejected;

  return {
    generatedAt: new Date().toISOString(),
    mode: allowApply ? `apply_${mode}_launchd` : 'audit',
    targetMode: mode,
    promotionGateRequired,
    livePromotionGate: liveGate,
    applyRequested: args.apply,
    applyAllowed: allowApply,
    applyRejected,
    confirmRequired: args.apply && !confirmOk ? (expectedConfirm || '--mode=dry-run|--mode=live') : null,
    ok,
    expectedCount: EXPECTED_COUNT,
    plistCount: plists.length,
    loadedCount,
    missingLabels: missing,
    reloadRequiredLabels: reloadRequired,
    validationFailureCount: validationFailures.length,
    entries,
    nextStep: ok
      ? [mode === 'live'
          ? 'Edu-X live LaunchAgents are loaded. Scheduled posts will publish when slot jobs run.'
          : 'Edu-X dry-run LaunchAgents are loaded. Continue dry-run accumulation until promotion gate reaches 7/7.']
      : [
          applyRejected && !applyModeExplicit ? 'Apply requires an explicit --dry-run or --live mode.' : null,
          applyRejected && applyModeExplicit && args.confirm !== expectedConfirm ? `Re-run with --confirm=${expectedConfirm} to apply after blockers are clear.` : null,
          applyRejected && confirmOk && !sourceSetSafe ? 'Apply blocked until all expected plist files pass validation.' : null,
          mode === 'live' && promotionGateRequired && liveGate?.ok !== true ? `Live apply blocked until fresh non-fixture ${PROMOTION_GATE_REQUIRED_CHECKS}/7 promotion gate report is PASS.` : null,
          missing.length ? `Load missing dry-run LaunchAgents: ${missing.join(', ')}` : null,
          reloadRequired.length ? `Loaded LaunchAgents need explicit reload approval: ${reloadRequired.join(', ')}` : null,
          validationFailures.length ? 'Fix plist validation failures before applying.' : null,
        ].filter(Boolean),
  };
}

function main() {
  const args = parseArgs();
  const report = buildReport(args);
  if (!args.noWrite) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  const summary = `[edu-x/launchd-doctor] ${report.loadedCount}/${report.expectedCount} loaded, validation failures=${report.validationFailureCount}, ok=${report.ok}`;
  console.log(summary);
  if (report.missingLabels.length) console.log(`missing: ${report.missingLabels.join(', ')}`);
  if (report.reloadRequiredLabels.length) console.log(`reload required: ${report.reloadRequiredLabels.join(', ')}`);
  if (report.applyRejected) console.log(`apply rejected: pass --confirm=${report.confirmRequired}`);
  console.log(`report: ${args.noWrite ? '(no-write)' : REPORT_PATH}`);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  if (args.strict && !report.ok) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('[edu-x/launchd-doctor] failed:', err?.message || err);
    process.exit(1);
  }
}

module.exports = { buildReport };
