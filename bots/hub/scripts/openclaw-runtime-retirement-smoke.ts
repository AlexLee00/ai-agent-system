#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const retiredName = ['open', 'claw'].join('');
const retiredGatewayLabel = ['ai', retiredName, 'gateway'].join('.');
const retiredModelSyncLabel = ['ai', retiredName, 'model-sync'].join('.');
const retiredPort = ['187', '89'].join('');

function commandOutput(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return `${result.stdout || ''}${result.stderr || ''}`;
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
  const presentLaunchdFiles = launchdFiles.filter((filePath) => require('node:fs').existsSync(filePath));
  assert.deepEqual(presentLaunchdFiles, [], 'retired LaunchAgent/Daemon plists must be removed');

  const launchctl = commandOutput('launchctl', ['list']);
  assert(!launchctl.includes(retiredGatewayLabel), 'retired gateway launchd job must not be loaded');
  assert(!launchctl.includes(retiredModelSyncLabel), 'retired model-sync launchd job must not be loaded');

  console.log(JSON.stringify({
    ok: true,
    global_cli_removed: true,
    global_package_removed: true,
    launchd_jobs_removed: true,
  }));
}

main();
