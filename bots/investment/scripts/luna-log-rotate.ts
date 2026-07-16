#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const KEEP_DAYS = Math.max(1, Number(process.env.LUNA_LOG_ROTATE_KEEP_DAYS || 7));
const MIN_BYTES = Math.max(1, Number(process.env.LUNA_LOG_ROTATE_MIN_BYTES || 200 * 1024 * 1024));
const KEEP_LINES = Math.max(100, Math.round(Number(process.env.LUNA_LOG_ROTATE_KEEP_LINES || 5000)));

const DEFAULT_FILES = [
  '/tmp/investment-runtime-autopilot.log',
  '/tmp/ai.luna.ops-scheduler.out.log',
  '/tmp/ai.luna.ops-scheduler.err.log',
  '/tmp/ai.luna.tradingview-ws.log',
  '/tmp/ai.luna.tradingview-ws.err.log',
  '/tmp/ai.luna.marketdata-mcp.log',
  '/tmp/ai.luna.marketdata-mcp.err.log',
  '/Users/alexlee/.ai-agent-system/logs/luna-jaenong-collector.log',
  '/Users/alexlee/.ai-agent-system/logs/luna-jaenong-collector-error.log',
];

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function archivePath(filePath) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}-${todayStr()}${ext || '.log'}`;
}

function collectLogFiles() {
  const configured = String(process.env.LUNA_LOG_ROTATE_FILES || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const files = new Set([...DEFAULT_FILES, ...configured]);
  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (/^ai\.luna\..*\.(log|err\.log|out\.log)$/.test(name)) {
        files.add(path.join('/tmp', name));
      }
    }
  } catch {
    // /tmp should exist; ignore if a sandboxed environment lacks it.
  }
  return [...files].sort();
}

function copyTailIntoFile(filePath, keepLines = KEEP_LINES) {
  const tmpPath = path.join(os.tmpdir(), `luna-log-rotate-${process.pid}-${Date.now()}.keep`);
  const tail = spawnSync('/usr/bin/tail', ['-n', String(keepLines), filePath], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (tail.status !== 0) throw new Error(tail.stderr || `tail failed status=${tail.status}`);
  fs.writeFileSync(tmpPath, tail.stdout || '', 'utf8');
  fs.copyFileSync(tmpPath, filePath);
  fs.unlinkSync(tmpPath);
}

export function rotateLunaLogFile(filePath, { dryRun = false } = {}) {
  if (!fs.existsSync(filePath)) return { filePath, status: 'skip', reason: 'not_found' };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { filePath, status: 'skip', reason: 'not_file' };
  if (stat.size < MIN_BYTES) {
    return { filePath, status: 'skip', reason: `${stat.size}B < ${MIN_BYTES}B`, size: stat.size };
  }

  const archive = archivePath(filePath);
  if (!dryRun) {
    if (!fs.existsSync(archive)) fs.copyFileSync(filePath, archive);
    copyTailIntoFile(filePath);
  }
  return { filePath, status: dryRun ? 'would_rotate' : 'rotated', archive, size: stat.size, keepLines: KEEP_LINES };
}

function purgeOldArchives(filePath, { dryRun = false } = {}) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const suffix = ext || '.log';
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(`${base}-`) || !name.endsWith(suffix)) continue;
    const fullPath = path.join(dir, name);
    try {
      if (fs.statSync(fullPath).mtimeMs < cutoff) {
        if (!dryRun) fs.unlinkSync(fullPath);
        purged += 1;
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
  return purged;
}

export function runLunaLogRotate({ dryRun = false } = {}) {
  const files = collectLogFiles();
  const results = files.map((filePath) => {
    const result = rotateLunaLogFile(filePath, { dryRun });
    const purged = result.status === 'rotated' || result.status === 'would_rotate'
      ? purgeOldArchives(filePath, { dryRun })
      : 0;
    return { ...result, purged };
  });
  const rotated = results.filter((item) => item.status === 'rotated' || item.status === 'would_rotate').length;
  const skipped = results.length - rotated;
  return {
    ok: true,
    status: dryRun ? 'luna_log_rotate_dry_run' : 'luna_log_rotate_complete',
    dryRun,
    minBytes: MIN_BYTES,
    keepLines: KEEP_LINES,
    keepDays: KEEP_DAYS,
    summary: { files: results.length, rotated, skipped, purged: results.reduce((sum, item) => sum + Number(item.purged || 0), 0) },
    results,
  };
}

async function main() {
  const result = runLunaLogRotate({ dryRun: hasArg('dry-run') });
  if (hasArg('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} rotated=${result.summary.rotated} skipped=${result.summary.skipped}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-log-rotate failed:' });
}
