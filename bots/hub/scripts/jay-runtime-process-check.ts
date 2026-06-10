#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function hasArg(name: string) {
  return process.argv.includes(name);
}

function argValue(prefix: string, fallback = '') {
  const match = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : fallback;
}

function normalizeText(value: unknown, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tailFile(filePath: string, maxLines = 12) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function redactLine(line: unknown) {
  return String(line || '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1<redacted>')
    .replace(/(token|secret|password|api[_-]?key)=([^&\s]+)/gi, '$1=<redacted>');
}

function parsePid(printOutput: unknown) {
  const match = String(printOutput || '').match(/\bpid\s*=\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function isPidAlive(pid: number | null) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number | null) {
  if (!pid) return null;
  const result = run('ps', ['-p', String(pid), '-o', 'command=']);
  if (Number(result.status) !== 0) return null;
  return redactLine(normalizeText(result.stdout)).slice(0, 600) || null;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXPECTED_DAEMON_PATH = path.join(REPO_ROOT, 'dist', 'daemons', 'ai.jay.runtime.cjs');

function normalizeCommandPath(value: unknown) {
  return String(value || '').replace(/\\/g, '/');
}

function classifyJayRuntimeCommand(command: unknown) {
  const normalized = normalizeCommandPath(command);
  const expectedDaemon = normalizeCommandPath(EXPECTED_DAEMON_PATH);
  if (normalized.includes(expectedDaemon)) return 'prebuilt_daemon';
  if (/(^|\s|\/)bots\/orchestrator\/src\/jay-runtime\.ts(\s|$)/.test(normalized)) return 'source_tsx';
  if (/(^|\s|\/)jay-runtime\.js(\s|$)/.test(normalized)) return 'legacy_js';
  return 'unknown';
}

function isJayRuntimeCommand(command: unknown) {
  return classifyJayRuntimeCommand(command) !== 'unknown';
}

function collectState(strict: boolean) {
  const uid = process.getuid ? process.getuid() : Number(process.env.UID || 0);
  const label = 'ai.jay.runtime';
  const print = run('launchctl', ['print', `gui/${uid}/${label}`]);
  const loaded = Number(print.status) === 0;
  const pid = loaded ? parsePid(print.stdout) : null;
  const runtimeDir = process.env.JAY_RUNTIME_DIR
    || process.env.HUB_RUNTIME_DIR
    || path.join(os.homedir(), '.ai-agent-system', 'jay');
  const lockPath = path.join(runtimeDir, 'jay-runtime.lock');
  const lockPid = fs.existsSync(lockPath) ? Number(normalizeText(fs.readFileSync(lockPath, 'utf8'))) || null : null;
  const lockPidAlive = isPidAlive(lockPid);
  const lockCommand = readProcessCommand(lockPid);
  const launchdCommand = readProcessCommand(pid);
  const runtimeCommand = lockCommand || launchdCommand;
  const commandMode = classifyJayRuntimeCommand(runtimeCommand);
  const lockOwner = !fs.existsSync(lockPath)
    ? 'missing'
    : (!lockPidAlive ? 'stale' : (isJayRuntimeCommand(lockCommand) ? 'jay-runtime' : 'foreign'));
  const lockMatchesLaunchdPid = Boolean(pid && lockPid && pid === lockPid);
  const lockMatchesRuntimeChild = Boolean(loaded && pid && lockPidAlive && lockOwner === 'jay-runtime');
  const prebuiltDaemon = commandMode === 'prebuilt_daemon';
  const strictOk = Boolean(loaded && pid && (lockMatchesLaunchdPid || lockMatchesRuntimeChild) && prebuiltDaemon);
  const stdoutPath = path.join(os.homedir(), '.ai-agent-system', 'logs', 'jay-runtime.log');
  const stderrPath = path.join(os.homedir(), '.ai-agent-system', 'logs', 'jay-runtime-error.log');
  const stdoutTail = tailFile(stdoutPath).map(redactLine);
  const stderrTail = tailFile(stderrPath).map(redactLine);

  return {
    ok: !strict || strictOk,
    strict,
    label,
    loaded,
    pid,
    lock: {
      path: lockPath,
      exists: fs.existsSync(lockPath),
      pid: lockPid,
      pidAlive: lockPidAlive,
      owner: lockOwner,
      foreign: lockOwner === 'foreign',
      command: lockCommand,
      matchesLaunchdPid: lockMatchesLaunchdPid,
      matchesRuntimeChild: lockMatchesRuntimeChild,
    },
    runtime: {
      expectedDaemonPath: EXPECTED_DAEMON_PATH,
      command: runtimeCommand,
      launchdCommand,
      commandMode,
      prebuiltDaemon,
    },
    logs: {
      stdoutPath,
      stderrPath,
      stdoutTail,
      stderrTail,
    },
    launchctl: {
      status: Number(print.status || 0),
      error: normalizeText(print.stderr || print.stdout).slice(0, 600) || null,
    },
  };
}

async function main() {
  const strict = hasArg('--strict');
  const json = hasArg('--json') || strict;
  const waitMs = Math.max(0, Number(argValue('--wait-ms', strict ? '15000' : '0')) || 0);
  const deadline = Date.now() + waitMs;
  let payload = collectState(strict);

  while (strict && !payload.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    payload = collectState(strict);
  }

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`# Jay runtime process (${payload.ok ? 'ok' : 'not-loaded'})`);
    console.log(`loaded: ${payload.loaded}`);
    console.log(`pid: ${payload.pid || '-'}`);
    console.log(`lock: ${payload.lock.exists ? payload.lock.pid : '-'} owner=${payload.lock.owner} launchd_match=${payload.lock.matchesLaunchdPid} runtime_child=${payload.lock.matchesRuntimeChild}`);
    console.log(`runtime: ${payload.runtime.commandMode} prebuilt=${payload.runtime.prebuiltDaemon}`);
    if (!payload.loaded && payload.launchctl.error) console.log(`launchctl: ${payload.launchctl.error.split('\n')[0]}`);
  }

  if (!payload.ok) process.exit(1);
}

main().catch((error) => {
  console.error(`jay_runtime_process_check_failed: ${error?.message || error}`);
  process.exit(1);
});
