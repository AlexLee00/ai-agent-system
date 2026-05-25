'use strict';

/**
 * Hub/Dexter 로그 copytruncate 로테이션.
 *
 * launchd는 로그 파일 핸들을 유지하므로 rename 대신 copy + truncate를 사용한다.
 */

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = Math.max(1, Number(process.env.HUB_LOG_ROTATE_KEEP_DAYS || 7) || 7);
const MIN_BYTES = Math.max(1, Number(process.env.HUB_LOG_ROTATE_MIN_BYTES || 1024 * 1024) || 1024 * 1024);

const ROOT = path.resolve(__dirname, '../../..');

const ROTATE_FILES = [
  path.join(ROOT, 'bots/hub/hub.log'),
  path.join(ROOT, 'bots/hub/hub.err.log'),
  path.join(ROOT, 'bots/hub/hub-green.log'),
  path.join(ROOT, 'bots/hub/hub-green.err.log'),
  path.join(ROOT, 'bots/claude/dexter.log'),
  path.join(ROOT, 'bots/claude/dexter.err.log'),
  path.join(ROOT, 'bots/claude/auto-dev.autonomous.log'),
  '/tmp/elixir-supervisor.log',
  '/tmp/elixir-supervisor.err',
  '/tmp/hub-hourly-status-digest.log',
  '/tmp/hub-hourly-status-digest.err.log',
  '/tmp/hub-llm-oauth-monitor.log',
  '/tmp/hub-llm-oauth-monitor.err.log',
];

function todayStr() {
  return new Date().toLocaleDateString('en-CA');
}

function archivePath(filePath: string) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}-${todayStr()}${ext || '.log'}`;
}

function rotateFile(filePath: string) {
  if (!fs.existsSync(filePath)) return { status: 'skip', reason: 'not found' };

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { status: 'skip', reason: 'not a file' };
  if (stat.size < MIN_BYTES) return { status: 'skip', reason: `${stat.size}B < ${MIN_BYTES}B` };

  const archive = archivePath(filePath);
  if (!fs.existsSync(archive)) {
    fs.copyFileSync(filePath, archive);
  }
  fs.truncateSync(filePath, 0);
  return { status: 'rotated', archive, size: stat.size };
}

function purgeOldArchives(filePath: string) {
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
        fs.unlinkSync(fullPath);
        purged += 1;
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
  return purged;
}

function main() {
  let rotated = 0;
  let skipped = 0;
  let purged = 0;

  console.log(`[hub-log-rotate] start ${new Date().toISOString()}`);
  for (const filePath of ROTATE_FILES) {
    const result = rotateFile(filePath);
    if (result.status === 'rotated') {
      rotated += 1;
      purged += purgeOldArchives(filePath);
      console.log(`[hub-log-rotate] rotated ${filePath} -> ${result.archive} (${result.size} bytes)`);
    } else {
      skipped += 1;
      console.log(`[hub-log-rotate] skipped ${filePath}: ${result.reason}`);
    }
  }
  console.log(`[hub-log-rotate] done rotated=${rotated} skipped=${skipped} purged=${purged}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  rotateFile,
  purgeOldArchives,
};
