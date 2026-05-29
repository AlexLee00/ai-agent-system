#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DATA_VOLUME = process.env.LUNA_CACHE_CLEANUP_VOLUME || '/System/Volumes/Data';
const DISK_THRESHOLD_PCT = parseOptionalNumber(process.env.LUNA_CACHE_CLEANUP_DISK_THRESHOLD_PCT);
const THRESHOLD_ONLY = truthy(process.env.LUNA_CACHE_CLEANUP_THRESHOLD_ONLY);
const RUN_COMMANDS = truthy(process.env.LUNA_CACHE_CLEANUP_RUN_COMMANDS ?? 'true');
const MEASURE_PROTECTED = truthy(process.env.LUNA_CACHE_CLEANUP_MEASURE_PROTECTED);
const HOME = os.homedir();

const COMMAND_TARGETS = [
  {
    id: 'homebrew_cleanup',
    command: 'brew',
    args: ['cleanup', '--prune=all'],
    description: 'Homebrew download/build cache cleanup',
    sizePaths: [path.join(HOME, 'Library/Caches/Homebrew')],
  },
  {
    id: 'pip_cache_purge',
    command: 'pip',
    args: ['cache', 'purge'],
    fallbackCommand: 'python3',
    fallbackArgs: ['-m', 'pip', 'cache', 'purge'],
    description: 'Python pip cache purge',
    sizePaths: [path.join(HOME, 'Library/Caches/pip'), path.join(HOME, '.cache/pip')],
  },
  {
    id: 'pnpm_store_prune',
    command: 'pnpm',
    args: ['store', 'prune'],
    description: 'pnpm store prune',
    sizePaths: [path.join(HOME, 'Library/pnpm/store')],
  },
  {
    id: 'npm_cache_clean',
    command: 'npm',
    args: ['cache', 'clean', '--force'],
    description: 'npm cache clean',
    sizePaths: [path.join(HOME, '.npm/_cacache')],
  },
];

const DIRECTORY_TARGETS = [
  {
    id: 'npm_npx_cache',
    path: path.join(HOME, '.npm/_npx'),
    description: 'npx execution cache',
  },
  {
    id: 'hardhat_nodejs_cache',
    path: path.join(HOME, 'Library/Caches/hardhat-nodejs'),
    description: 'Hardhat nodejs build cache',
  },
  {
    id: 'node_gyp_cache',
    path: path.join(HOME, 'Library/Caches/node-gyp'),
    description: 'node-gyp build cache',
  },
  {
    id: 'vscode_shipit_cache',
    path: path.join(HOME, 'Library/Caches/com.microsoft.VSCode.ShipIt'),
    description: 'VSCode update cache',
  },
  {
    id: 'claude_desktop_cache',
    path: path.join(HOME, 'Library/Application Support/Claude/Cache'),
    description: 'Claude Desktop cache only; conversation stores are excluded',
  },
  {
    id: 'claude_desktop_code_cache',
    path: path.join(HOME, 'Library/Application Support/Claude/Code Cache'),
    description: 'Claude Desktop code cache only',
  },
];

const PROTECTED_PATH_FRAGMENTS = [
  'Draw Things',
  'com.liuliu.draw-things',
  'Application Support/Claude/vm_bundles',
  'Application Support/Claude/IndexedDB',
  'Application Support/Claude/Local Storage',
  'Application Support/Google',
  'Caches/ms-playwright',
  'projects/ai-agent-system',
];

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function truthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value || '').trim());
}

function parseOptionalNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bytesToHuman(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, Number(bytes) || 0);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function diskSnapshot(volume = DATA_VOLUME) {
  const df = run('/bin/df', ['-Pk', volume]);
  if (df.status !== 0) {
    return { ok: false, volume, error: (df.stderr || df.stdout || '').trim() };
  }
  const lines = String(df.stdout || '').trim().split(/\n/);
  const parts = String(lines[1] || '').trim().split(/\s+/);
  const totalKiB = Number(parts[1] || 0);
  const usedKiB = Number(parts[2] || 0);
  const availableKiB = Number(parts[3] || 0);
  const capacityPct = Number(String(parts[4] || '').replace('%', ''));
  return {
    ok: true,
    volume,
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availableBytes: availableKiB * 1024,
    capacityPct,
    raw: lines.join('\n'),
  };
}

function sizeOfPath(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return 0;
  const du = run('/usr/bin/du', ['-sk', targetPath]);
  if (du.status !== 0) return 0;
  const kib = Number(String(du.stdout || '').trim().split(/\s+/)[0] || 0);
  return Number.isFinite(kib) ? kib * 1024 : 0;
}

function sizeOfPaths(paths) {
  return paths.reduce((sum, targetPath) => sum + sizeOfPath(targetPath), 0);
}

function assertAllowedPath(targetPath) {
  const normalized = path.resolve(targetPath);
  for (const fragment of PROTECTED_PATH_FRAGMENTS) {
    if (normalized.includes(fragment)) {
      throw new Error(`protected_path_refused:${normalized}`);
    }
  }
  if (!normalized.startsWith(HOME) && !normalized.startsWith('/tmp/')) {
    throw new Error(`outside_allowed_roots:${normalized}`);
  }
  return normalized;
}

function removeDirectoryContents(targetPath) {
  const normalized = assertAllowedPath(targetPath);
  if (!fs.existsSync(normalized)) return { removed: 0, missing: true };
  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) return { removed: 0, missing: false, notDirectory: true };
  let removed = 0;
  for (const name of fs.readdirSync(normalized)) {
    const child = path.join(normalized, name);
    fs.rmSync(child, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, missing: false };
}

function runCommandTarget(target, { dryRun = false } = {}) {
  const beforeBytes = sizeOfPaths(target.sizePaths);
  const result = {
    id: target.id,
    type: 'command',
    description: target.description,
    command: [target.command, ...target.args].join(' '),
    fallbackCommand: target.fallbackCommand ? [target.fallbackCommand, ...target.fallbackArgs].join(' ') : null,
    sizePaths: target.sizePaths,
    beforeBytes,
    beforeHuman: bytesToHuman(beforeBytes),
    status: dryRun ? 'would_run' : 'pending',
  };

  if (dryRun || !RUN_COMMANDS) {
    return { ...result, status: dryRun ? 'would_run' : 'skipped_run_commands_disabled', afterBytes: beforeBytes, recoveredBytes: 0 };
  }

  let executed = run(target.command, target.args);
  let usedFallback = false;
  if (executed.status !== 0 && target.fallbackCommand) {
    usedFallback = true;
    executed = run(target.fallbackCommand, target.fallbackArgs);
  }

  const afterBytes = sizeOfPaths(target.sizePaths);
  return {
    ...result,
    status: executed.status === 0 ? 'cleaned' : 'failed',
    usedFallback,
    exitStatus: executed.status,
    stdoutTail: String(executed.stdout || '').slice(-2000),
    stderrTail: String(executed.stderr || '').slice(-2000),
    afterBytes,
    afterHuman: bytesToHuman(afterBytes),
    recoveredBytes: Math.max(0, beforeBytes - afterBytes),
    recoveredHuman: bytesToHuman(Math.max(0, beforeBytes - afterBytes)),
  };
}

function runDirectoryTarget(target, { dryRun = false } = {}) {
  const targetPath = assertAllowedPath(target.path);
  const beforeBytes = sizeOfPath(targetPath);
  const result = {
    id: target.id,
    type: 'directory_contents',
    description: target.description,
    path: targetPath,
    beforeBytes,
    beforeHuman: bytesToHuman(beforeBytes),
    status: dryRun ? 'would_delete_contents' : 'pending',
  };

  if (dryRun) {
    return { ...result, afterBytes: beforeBytes, recoveredBytes: 0 };
  }

  try {
    const removal = removeDirectoryContents(targetPath);
    const afterBytes = sizeOfPath(targetPath);
    return {
      ...result,
      status: removal.missing ? 'skip_missing' : removal.notDirectory ? 'skip_not_directory' : 'cleaned',
      removedEntries: removal.removed,
      afterBytes,
      afterHuman: bytesToHuman(afterBytes),
      recoveredBytes: Math.max(0, beforeBytes - afterBytes),
      recoveredHuman: bytesToHuman(Math.max(0, beforeBytes - afterBytes)),
    };
  } catch (error) {
    return {
      ...result,
      status: 'failed',
      error: error?.message || String(error),
      afterBytes: beforeBytes,
      recoveredBytes: 0,
    };
  }
}

function shouldRunForDisk(beforeDisk) {
  if (DISK_THRESHOLD_PCT == null) {
    return { shouldRun: true, reason: 'scheduled_or_manual_run', thresholdPct: null };
  }
  const exceeded = Number(beforeDisk.capacityPct || 0) >= DISK_THRESHOLD_PCT;
  if (exceeded || !THRESHOLD_ONLY) {
    return {
      shouldRun: true,
      reason: exceeded ? 'threshold_exceeded' : 'scheduled_run_threshold_not_required',
      thresholdPct: DISK_THRESHOLD_PCT,
      thresholdOnly: THRESHOLD_ONLY,
    };
  }
  return {
    shouldRun: false,
    reason: 'below_threshold',
    thresholdPct: DISK_THRESHOLD_PCT,
    thresholdOnly: THRESHOLD_ONLY,
  };
}

function protectedInventory() {
  const paths = {
    drawThingsDocuments: path.join(HOME, 'Library/Containers/com.liuliu.draw-things/Data/Documents'),
    claudeVmBundles: path.join(HOME, 'Library/Application Support/Claude/vm_bundles'),
    claudeIndexedDb: path.join(HOME, 'Library/Application Support/Claude/IndexedDB'),
    claudeLocalStorage: path.join(HOME, 'Library/Application Support/Claude/Local Storage'),
    chromeAppSupport: path.join(HOME, 'Library/Application Support/Google'),
    playwrightCache: path.join(HOME, 'Library/Caches/ms-playwright'),
    projectRoot: path.resolve(process.cwd()),
  };
  return Object.fromEntries(
    Object.entries(paths).map(([key, targetPath]) => {
      const exists = fs.existsSync(targetPath);
      if (!MEASURE_PROTECTED) {
        return [key, { path: targetPath, exists, measured: false }];
      }
      const bytes = sizeOfPath(targetPath);
      return [key, { path: targetPath, exists, measured: true, bytes, human: bytesToHuman(bytes) }];
    }),
  );
}

export function runLunaCacheCleanup({ dryRun = false } = {}) {
  const beforeDisk = diskSnapshot();
  const gate = shouldRunForDisk(beforeDisk);
  const targets = [
    ...COMMAND_TARGETS.map((target) => ({ id: target.id, type: 'command', paths: target.sizePaths })),
    ...DIRECTORY_TARGETS.map((target) => ({ id: target.id, type: 'directory_contents', path: target.path })),
  ];
  const estimatedRecoverableBytes =
    COMMAND_TARGETS.reduce((sum, target) => sum + sizeOfPaths(target.sizePaths), 0) +
    DIRECTORY_TARGETS.reduce((sum, target) => sum + sizeOfPath(target.path), 0);

  if (!gate.shouldRun) {
    return {
      ok: true,
      status: 'luna_cache_cleanup_skipped',
      dryRun,
      gate,
      beforeDisk,
      afterDisk: beforeDisk,
      estimatedRecoverableBytes,
      estimatedRecoverableHuman: bytesToHuman(estimatedRecoverableBytes),
      targets,
      protectedInventory: protectedInventory(),
      results: [],
    };
  }

  const results = [
    ...COMMAND_TARGETS.map((target) => runCommandTarget(target, { dryRun })),
    ...DIRECTORY_TARGETS.map((target) => runDirectoryTarget(target, { dryRun })),
  ];
  const afterDisk = dryRun ? beforeDisk : diskSnapshot();
  const recoveredBytes = Math.max(0, Number(afterDisk.availableBytes || 0) - Number(beforeDisk.availableBytes || 0));

  return {
    ok: results.every((item) => item.status !== 'failed'),
    status: dryRun ? 'luna_cache_cleanup_dry_run' : 'luna_cache_cleanup_complete',
    dryRun,
    gate,
    beforeDisk,
    afterDisk,
    estimatedRecoverableBytes,
    estimatedRecoverableHuman: bytesToHuman(estimatedRecoverableBytes),
    recoveredBytes,
    recoveredHuman: bytesToHuman(recoveredBytes),
    protectedInventory: protectedInventory(),
    summary: {
      targets: results.length,
      cleaned: results.filter((item) => item.status === 'cleaned').length,
      wouldRun: results.filter((item) => String(item.status).startsWith('would_')).length,
      failed: results.filter((item) => item.status === 'failed').length,
      recoveredBytes: results.reduce((sum, item) => sum + Number(item.recoveredBytes || 0), 0),
      recoveredHuman: bytesToHuman(results.reduce((sum, item) => sum + Number(item.recoveredBytes || 0), 0)),
    },
    results,
  };
}

async function main() {
  const result = runLunaCacheCleanup({ dryRun: hasArg('dry-run') });
  if (hasArg('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} targets=${result.summary?.targets || 0} recovered=${result.recoveredHuman || '0B'}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-cache-cleanup failed:' });
}
