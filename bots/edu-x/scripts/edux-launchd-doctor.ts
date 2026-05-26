#!/usr/bin/env node
// @ts-nocheck
'use strict';

/**
 * edux-launchd-doctor.ts
 *
 * Audits and optionally bootstraps the five Edu-X dry-run LaunchAgents.
 * The apply path is intentionally narrow: it only loads missing ai.edux.*
 * agents after every plist proves EDUX_DRY_RUN=true and live publish flags
 * are false. It never unloads, restarts, or kickstarts an existing service.
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
const CONFIRM_TOKEN = 'edux-launchd-dry-run';
const LABEL_PREFIX = 'ai.edux.';
const EXPECTED_COUNT = 5;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    apply: false,
    confirm: null,
    json: false,
    noWrite: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--apply') args.apply = true;
    else if (item === '--json') args.json = true;
    else if (item === '--no-write') args.noWrite = true;
    else if (item === '--strict') args.strict = true;
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

function validatePlist(filePath, plist) {
  const issues = [];
  const label = String(plist.Label || '');
  const envVars = plist.EnvironmentVariables || {};
  const programArgs = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const calendar = plist.StartCalendarInterval || {};

  if (!label.startsWith(LABEL_PREFIX)) issues.push('label_not_ai_edux');
  if (!path.basename(filePath).startsWith(`${label}.`)) issues.push('filename_label_mismatch');
  if (envVars.EDUX_DRY_RUN !== 'true') issues.push('EDUX_DRY_RUN_not_true');
  if (envVars.EDUX_LIVE_PUBLISH_APPROVED !== 'false') issues.push('EDUX_LIVE_PUBLISH_APPROVED_not_false');
  if (envVars.EDUX_PROMOTION_GATE_PASSED !== 'false') issues.push('EDUX_PROMOTION_GATE_PASSED_not_false');
  if (plist.RunAtLoad !== false) issues.push('RunAtLoad_not_false');
  if (plist.KeepAlive !== false) issues.push('KeepAlive_not_false');
  if (!Number.isInteger(calendar.Hour) || !Number.isInteger(calendar.Minute)) issues.push('StartCalendarInterval_missing');
  if (programArgs.length < 2) issues.push('ProgramArguments_incomplete');
  if (programArgs[0] && !fs.existsSync(programArgs[0])) issues.push(`node_missing:${programArgs[0]}`);
  if (programArgs[1] && !fs.existsSync(programArgs[1])) issues.push(`runtime_missing:${programArgs[1]}`);

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

function buildReport(args) {
  const allowApply = args.apply && args.confirm === CONFIRM_TOKEN;
  const applyRejected = args.apply && !allowApply;
  const plists = listPlists();
  const entries = plists.map((filePath) => {
    const plist = readPlist(filePath);
    const label = String(plist.Label || path.basename(filePath, '.plist'));
    const issues = validatePlist(filePath, plist);
    const destination = destinationFor(filePath);
    const safeToApply = issues.length === 0;
    const loadedBefore = isLoaded(label);
    const copy = safeToApply ? copyPlist(filePath, destination, allowApply) : { action: 'blocked_by_validation', path: destination };
    const bootstrap = safeToApply ? bootstrapPlist(label, destination, allowApply, loadedBefore) : { action: 'blocked_by_validation', loadedAfter: false };
    const loaded = isLoaded(label);
    const reloadRequired = safeToApply && loadedBefore && copy.inSyncBefore === false;
    return {
      label,
      source: filePath,
      destination,
      schedule: plist.StartCalendarInterval || null,
      dryRun: plist.EnvironmentVariables?.EDUX_DRY_RUN || null,
      liveApproved: plist.EnvironmentVariables?.EDUX_LIVE_PUBLISH_APPROVED || null,
      promotionGatePassed: plist.EnvironmentVariables?.EDUX_PROMOTION_GATE_PASSED || null,
      validationIssues: issues,
      copy,
      bootstrap,
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
    && !applyRejected;

  return {
    generatedAt: new Date().toISOString(),
    mode: allowApply ? 'apply_dry_run_launchd' : 'audit',
    applyRequested: args.apply,
    applyAllowed: allowApply,
    applyRejected,
    confirmRequired: args.apply && !allowApply ? CONFIRM_TOKEN : null,
    ok,
    expectedCount: EXPECTED_COUNT,
    plistCount: plists.length,
    loadedCount,
    missingLabels: missing,
    reloadRequiredLabels: reloadRequired,
    validationFailureCount: validationFailures.length,
    entries,
    nextStep: ok
      ? ['Edu-X dry-run LaunchAgents are loaded. Continue dry-run accumulation until promotion gate reaches 5/5.']
      : [
          applyRejected ? `Re-run with --confirm=${CONFIRM_TOKEN} to apply.` : null,
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
  if (report.applyRejected) console.log(`apply rejected: pass --confirm=${CONFIRM_TOKEN}`);
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
