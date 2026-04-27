#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const retiredName = ['open', 'claw'].join('');
const homeDir = path.join(os.homedir(), `.${retiredName}`);
const archiveRoot = path.join(os.homedir(), '.ai-agent-system', 'archives');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function directorySizeMb(dir: string): number {
  const result = run('du', ['-sm', dir]);
  if (Number(result.status) !== 0) return 0;
  const value = Number(String(result.stdout || '').trim().split(/\s+/)[0]);
  return Number.isFinite(value) ? value : 0;
}

function countFiles(dir: string): number {
  const result = run('find', [dir, '-type', 'f']);
  if (Number(result.status) !== 0) return 0;
  return String(result.stdout || '').trim().split('\n').filter(Boolean).length;
}

function archivePath(): string {
  return path.join(archiveRoot, `retired-${retiredName}-home-${timestamp()}.tar.gz`);
}

function createArchive(target: string): { ok: boolean; path: string; error?: string } {
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const output = archivePath();
  const result = run('tar', [
    '-czf',
    output,
    '-C',
    os.homedir(),
    `.${retiredName}`,
  ]);
  if (Number(result.status) !== 0) {
    return {
      ok: false,
      path: output,
      error: (result.stderr || result.stdout || `tar exited ${result.status}`).trim(),
    };
  }
  fs.chmodSync(output, 0o600);
  return { ok: true, path: output };
}

function maybeDeleteHome(): { deleted: boolean; reason?: string } {
  if (!hasFlag('delete-after-archive')) {
    return { deleted: false, reason: 'delete_after_archive_not_requested' };
  }
  const expected = `DELETE_${retiredName.toUpperCase()}_HOME`;
  if (String(process.env.HUB_RETIRED_GATEWAY_DELETE_CONFIRM || '') !== expected) {
    return { deleted: false, reason: 'delete_confirmation_missing' };
  }
  fs.rmSync(homeDir, { recursive: true, force: true });
  return { deleted: true };
}

function main(): void {
  const apply = hasFlag('apply');
  const exists = fs.existsSync(homeDir);
  const summary: Record<string, unknown> = {
    ok: true,
    dry_run: !apply,
    home_exists: exists,
    home_path: homeDir,
    archive_root: archiveRoot,
    note: 'Archive may contain credentials and browser/session data. It is local-only and must not be committed.',
  };

  if (!exists) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  summary.size_mb = directorySizeMb(homeDir);
  summary.file_count = countFiles(homeDir);
  summary.requires_explicit_delete_confirmation = true;

  if (!apply) {
    summary.recommended_next_command = 'npm --prefix bots/hub run -s retired-gateway:archive-home -- --apply';
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const archived = createArchive(homeDir);
  summary.archive = archived;
  if (!archived.ok) {
    summary.ok = false;
    console.log(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
  summary.delete_result = maybeDeleteHome();
  console.log(JSON.stringify(summary, null, 2));
}

main();
