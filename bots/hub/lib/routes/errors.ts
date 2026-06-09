const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = '/tmp';
const ERR_SUFFIX = '.err.log';
const RECENT_TAIL_BYTES = 128 * 1024;
const RECENT_TAIL_LINES = 400;
const RECOVERY_QUIET_LINES = 50;

type ErrorSummary = {
  service: string;
  file: string;
  size_bytes: number;
  modified_at: string;
  error_count: number;
  recent_errors: string[];
};

function isErrorLikeLine(line: string) {
  return /❌|error|exception|traceback|fatal|uncaught|rejected|failed/i.test(line);
}

function readRecentLogWindow(filePath: string, stat: any): string {
  if (stat.size <= RECENT_TAIL_BYTES) return fs.readFileSync(filePath, 'utf8');

  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(RECENT_TAIL_BYTES);
    const start = Math.max(0, stat.size - RECENT_TAIL_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, RECENT_TAIL_BYTES, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.replace(/^[^\n]*(\n|$)/, '');
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function recentErrorLines(filePath: string, stat: any): string[] {
  const lines = readRecentLogWindow(filePath, stat)
    .split('\n')
    .slice(-RECENT_TAIL_LINES)
    .map((line: string) => line.trim())
    .filter(Boolean);
  let lastErrorIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isErrorLikeLine(lines[i])) {
      lastErrorIndex = i;
      break;
    }
  }
  if (lastErrorIndex < 0) return [];

  const quietLinesAfterLastError = lines.length - lastErrorIndex - 1;
  if (quietLinesAfterLastError >= RECOVERY_QUIET_LINES) return [];

  return lines.filter(isErrorLikeLine);
}

export async function errorsRecentRoute(req: any, res: any) {
  const minutes = parseInt(req.query.minutes || '60', 10);
  const serviceFilter = req.query.service || null;
  const cutoffMs = Date.now() - (minutes * 60 * 1000);

  const files = fs.readdirSync(LOG_DIR)
    .filter((file: string) => file.endsWith(ERR_SUFFIX))
    .filter((file: string) => !serviceFilter || file.includes(serviceFilter));

  const results: ErrorSummary[] = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) continue;
      if (stat.size === 0) continue;

      // A recent mtime only proves the file was appended, not that every
      // historical error inside the file is recent. Limit the scan to the
      // newest log window so a harmless stderr append does not resurrect old
      // KIS/Hub failures for noisy long-running launchd logs.
      const lines = recentErrorLines(filePath, stat);
      if (lines.length === 0) continue;

      results.push({
        service: file.replace(ERR_SUFFIX, ''),
        file: filePath,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        error_count: lines.length,
        recent_errors: lines.slice(-5),
      });
    } catch {
      // 읽기 실패는 해당 파일만 건너뜀
    }
  }

  return res.json({
    ok: true,
    minutes,
    service_filter: serviceFilter,
    total_services: results.length,
    total_errors: results.reduce((sum, item) => sum + item.error_count, 0),
    services: results.sort((a, b) => b.error_count - a.error_count),
  });
}

export async function errorsSummaryRoute(_req: any, res: any) {
  const files = fs.readdirSync(LOG_DIR).filter((file: string) => file.endsWith(ERR_SUFFIX));
  const summary = [];

  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      summary.push({
        service: file.replace(ERR_SUFFIX, ''),
        size_bytes: stat.size,
        has_errors: stat.size > 0,
        modified_at: stat.mtime.toISOString(),
      });
    } catch {
      // 읽기 실패는 건너뜀
    }
  }

  return res.json({
    ok: true,
    total: summary.length,
    with_errors: summary.filter((item) => item.has_errors).length,
    clean: summary.filter((item) => !item.has_errors).length,
    services: summary.sort((a, b) => b.size_bytes - a.size_bytes),
  });
}
