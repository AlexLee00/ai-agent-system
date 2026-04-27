#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const retiredName = ['open', 'claw'].join('');
const retiredGatewayLabel = ['ai', retiredName, 'gateway'].join('.');
const retiredModelSyncLabel = ['ai', retiredName, 'model-sync'].join('.');
const retiredPort = ['187', '89'].join('');

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function scanCacheForRetiredMarkers(): string {
  const cacheDir = path.join(repoRoot, 'bots', 'worker', 'web', '.next');
  if (!pathExists(cacheDir)) return '';
  const result = spawnSync('rg', [
    '-n',
    '-S',
    `${retiredName}|${retiredGatewayLabel}|${retiredPort}`,
    cacheDir,
  ], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  if (![0, 1].includes(Number(result.status))) {
    throw new Error(`worker cache scan failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout || '';
}

function main(): void {
  const binCheck = spawnSync('which', [retiredName], { encoding: 'utf8' });
  assert.notEqual(Number(binCheck.status), 0, 'retired global CLI must not be installed on PATH');

  const globalList = commandOutput('npm', ['list', '-g', '--depth=0', retiredName]);
  assert(!globalList.includes(`/node_modules/${retiredName}`), 'retired global npm package must not be installed');

  const homeLaunchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const launchdFiles = [
    path.join(homeLaunchAgents, `${retiredGatewayLabel}.plist`),
    path.join(homeLaunchAgents, `${retiredModelSyncLabel}.plist`),
    path.join('/Library/LaunchAgents', `${retiredGatewayLabel}.plist`),
    path.join('/Library/LaunchAgents', `${retiredModelSyncLabel}.plist`),
    path.join('/Library/LaunchDaemons', `${retiredGatewayLabel}.plist`),
    path.join('/Library/LaunchDaemons', `${retiredModelSyncLabel}.plist`),
  ];
  const presentLaunchdFiles = launchdFiles.filter(pathExists);
  assert.deepEqual(presentLaunchdFiles, [], 'retired LaunchAgent/Daemon plists must be removed');

  const launchctl = commandOutput('launchctl', ['list']);
  assert(!launchctl.includes(retiredGatewayLabel), 'retired gateway launchd job must not be loaded');
  assert(!launchctl.includes(retiredModelSyncLabel), 'retired model-sync launchd job must not be loaded');

  const cacheFindings = scanCacheForRetiredMarkers();
  assert.equal(cacheFindings.trim(), '', 'worker .next cache must not contain retired gateway markers');

  console.log(JSON.stringify({
    ok: true,
    global_cli_removed: true,
    global_package_removed: true,
    launchd_jobs_removed: true,
    worker_next_cache_clean: true,
  }));
}

main();
