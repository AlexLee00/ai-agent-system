const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..', '..', '..');
const LOG_GLOBS = [
  '/tmp',
  path.join(REPO_ROOT, 'bots'),
];

type LogMatch = {
  line: string;
  line_no: number;
  level: string;
  service: string;
  file: string;
  modified_at: string;
};

type TailOptions = {
  query: string;
  level: string;
  minutes: number;
  service: string;
};

function collectLogFiles() {
  const files: string[] = [];

  function walk(dir: string) {
    let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }> = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith('.log') || entry.name.endsWith('.err.log'))) {
        files.push(fullPath);
      }
    }
  }

  for (const root of LOG_GLOBS) walk(root);
  return files;
}

function normalizeServiceName(filePath: string) {
  return path.basename(filePath).replace(/\.err\.log$/, '').replace(/\.log$/, '');
}

function detectLevel(line: string, filePath: string) {
  const text = String(line || '');
  const structured = text.match(/^\[[^\]]+\]\[(ERROR|WARN|INFO|DEBUG)\]/i);
  if (structured) {
    return structured[1].toUpperCase();
  }
  if (filePath.endsWith('.err.log')) return 'ERROR';
  if (/❌|error|exception|traceback|fatal|uncaught|rejected|failed/i.test(text)) return 'ERROR';
  if (/⚠️|warn/i.test(text)) return 'WARN';
  return 'INFO';
}

function tailMatches(filePath: string, { query, level, minutes, service }: TailOptions) {
  const stat = fs.statSync(filePath);
  if (minutes > 0) {
    const cutoffMs = Date.now() - minutes * 60 * 1000;
    if (stat.mtimeMs < cutoffMs) return [];
  }

  const serviceName = normalizeServiceName(filePath);
  if (service && !serviceName.includes(service)) return [];

  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map((line: string, idx: number) => ({ line: String(line || '').trim(), line_no: idx + 1 }))
    .filter((row: { line: string }) => row.line)
    .map((row: { line: string; line_no: number }) => ({
      ...row,
      level: detectLevel(row.line, filePath),
      service: serviceName,
      file: filePath,
      modified_at: stat.mtime.toISOString(),
    }))
    .filter((row: LogMatch) => !level || row.level === level)
    .filter((row: LogMatch) => !query || row.line.toLowerCase().includes(query));
}

export async function logsSearchRoute(req: any, res: any) {
  const query = String(req.query.q || '').trim().toLowerCase();
  const service = String(req.query.service || '').trim();
  const level = String(req.query.level || '').trim().toUpperCase();
  const minutes = Math.max(0, parseInt(req.query.minutes || '60', 10) || 60);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));

  const allFiles = collectLogFiles();
  const matches: LogMatch[] = [];

  for (const filePath of allFiles) {
    try {
      matches.push(...tailMatches(filePath, { query, level, minutes, service }));
    } catch {
      // ignore unreadable file
    }
  }

  matches.sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));

  return res.json({
    ok: true,
    q: query || null,
    service: service || null,
    level: level || null,
    minutes,
    total: matches.length,
    results: matches.slice(0, limit),
  });
}

export async function logsStatsRoute(_req: any, res: any) {
  const files = collectLogFiles();
  const stats = new Map<string, {
    service: string;
    files: number;
    bytes: number;
    errors: number;
    latest_modified_at: string | null;
  }>();

  for (const filePath of files) {
    try {
      const service = normalizeServiceName(filePath);
      const stat = fs.statSync(filePath);
      const item = stats.get(service) || {
        service,
        files: 0,
        bytes: 0,
        errors: 0,
        latest_modified_at: null,
      };
      item.files += 1;
      item.bytes += stat.size;
      if (filePath.endsWith('.err.log') || (stat.size > 0 && /error|failed|exception|fatal/i.test(fs.readFileSync(filePath, 'utf8')))) {
        item.errors += 1;
      }
      if (!item.latest_modified_at || stat.mtime.toISOString() > item.latest_modified_at) {
        item.latest_modified_at = stat.mtime.toISOString();
      }
      stats.set(service, item);
    } catch {
      // ignore unreadable file
    }
  }

  const services = [...stats.values()].sort((a, b) => b.bytes - a.bytes);
  return res.json({
    ok: true,
    total_services: services.length,
    total_files: services.reduce((sum, item) => sum + item.files, 0),
    services,
  });
}
