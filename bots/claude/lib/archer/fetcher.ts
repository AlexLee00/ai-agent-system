// @ts-nocheck
'use strict';

/**
 * lib/archer/fetcher.js — 데이터 수집기
 *
 * v2.0:
 *   - 제거: fetchFearGreed, fetchBinanceTicker, fetchLunaStats, fetchLunaPerformance, fetchSkaStats
 *   - 유지: fetchGithubRelease, fetchAllGithub, fetchNpmVersion, fetchAllNpm
 *   - 추가: fetchWebSource (RSS/HTML), fetchAllWebSources, runNpmAudit
 */

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const { execSync } = require('child_process');
const config   = require('./config');

const USAGE_EXCLUDES = [
  'node_modules',
  '.git',
  '.next',
  '.next_bak',
  'temp',
  'uploads',
  'reports',
  'tmp',
  'docs',
  'samples',
  'fixtures',
  'coverage',
];

const USAGE_FILE_EXCLUDES = [
  'package-lock.json',
  'PATCH_REQUEST.md',
  'docs/auto_dev/PATCH_REQUEST.md',
  'bots/claude/archer-cache.json',
  'bots/registry.json',
  'bots/claude/lib/archer/config.js',
];

const RUNTIME_PREFIXES = [
  'packages/core/',
  'bots/investment/shared/',
  'bots/investment/team/',
  'bots/investment/src/',
  'bots/orchestrator/',
  'bots/reservation/shared/',
  'bots/reservation/src/',
];

const SUPPORT_PREFIXES = [
  'bots/claude/lib/',
  'bots/claude/src/',
  'bots/investment/scripts/',
  'bots/reservation/scripts/',
];

// ─── 공통 HTTP 유틸 ─────────────────────────────────────────────────

function httpsGet(urlOrOpts, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const isUrl = typeof urlOrOpts === 'string';
    let mod = https;

    const req = (isUrl ? https : (urlOrOpts.ssl === false ? http : https)).get(
      isUrl
        ? (() => {
            const u = new URL(urlOrOpts);
            mod = u.protocol === 'http:' ? http : https;
            return { hostname: u.hostname, path: u.pathname + (u.search || ''), headers: { 'User-Agent': 'archer-bot/2.0' } };
          })()
        : urlOrOpts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 상대경로 리다이렉트 → 절대 URL로 변환
          let loc = res.headers.location;
          if (loc.startsWith('/') && typeof urlOrOpts === 'string') {
            const u = new URL(urlOrOpts);
            loc = `${u.protocol}//${u.host}${loc}`;
          }
          resolve(httpsGet(loc, timeout));
          return;
        }
        let raw = '';
        res.on('data', d => { raw += d; });
        res.on('end', () => resolve(raw));
      }
    );
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ─── GitHub Releases ─────────────────────────────────────────────────

async function fetchGithubRelease(name, apiUrl) {
  const token = loadGithubToken();
  try {
    const u = new URL(apiUrl);
    const headers = {
      'User-Agent': 'archer-bot/2.0',
      'Accept':     'application/vnd.github+json',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const raw = await httpsGet({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      headers,
    }, config.THRESHOLDS.githubTimeout);

    const data = JSON.parse(raw);
    return { name, tag: data.tag_name || null, published: data.published_at || null };
  } catch (e) {
    return { name, tag: null, error: e.message };
  }
}

async function fetchAllGithub() {
  const entries = Object.entries(config.GITHUB);
  const results = await Promise.all(entries.map(([n, u]) => fetchGithubRelease(n, u)));
  return Object.fromEntries(results.map(r => [r.name, r]));
}

// ─── npm Registry ─────────────────────────────────────────────────────

async function fetchNpmVersion(pkg) {
  try {
    const encoded = pkg.startsWith('@')
      ? pkg.replace('/', '%2F')
      : pkg;
    const raw = await httpsGet({
      hostname: config.NPM.BASE,
      path:     `/${encoded}/latest`,
      headers:  { 'User-Agent': 'archer-bot/2.0' },
    }, config.THRESHOLDS.npmTimeout);
    const data = JSON.parse(raw);
    return { pkg, version: data.version || null };
  } catch (e) {
    return { pkg, version: null, error: e.message };
  }
}

async function fetchAllNpm() {
  const results = await Promise.all(config.NPM.PACKAGES.map(p => fetchNpmVersion(p)));
  return Object.fromEntries(results.map(r => [r.pkg, r]));
}

function isTrackedUsagePath(filePath) {
  if (USAGE_FILE_EXCLUDES.includes(filePath)) return false;
  return !USAGE_EXCLUDES.some((segment) => filePath.includes(`/${segment}/`) || filePath.startsWith(`${segment}/`));
}

function scoreUsagePath(filePath) {
  if (RUNTIME_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'core';
  }
  if (SUPPORT_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return 'support';
  }
  return 'support';
}

function fetchPackageUsage(packages = []) {
  const usage = {};
  for (const pkg of packages) {
    try {
      const quoted = `'${pkg.replace(/'/g, `'\\''`)}'`;
      const raw = execSync(
        `rg -l ${quoted} ${config.ROOT} --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.next/**' --glob '!**/.next_bak*/**' --glob '!**/tmp/**' --glob '!**/reports/**' --glob '!**/temp/**' --glob '!**/uploads/**'`,
        {
          cwd: config.ROOT,
          encoding: 'utf8',
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const files = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.startsWith(config.ROOT) ? line.slice(config.ROOT.length + 1) : line)
        .filter(isTrackedUsagePath)
        .filter((file) => file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs') || file.endsWith('.ts') || file.endsWith('.json'))
        .slice(0, 20);
      const coreFiles = files.filter((file) => scoreUsagePath(file) === 'core');
      usage[pkg] = {
        count: files.length,
        coreCount: coreFiles.length,
        files,
        coreFiles: coreFiles.slice(0, 5),
      };
    } catch {
      usage[pkg] = { count: 0, coreCount: 0, files: [], coreFiles: [] };
    }
  }
  return usage;
}

// ─── npm audit ────────────────────────────────────────────────────────

/**
 * npm audit 실행 → { vulnerabilities, total, summary, error }
 * @param {string} cwd  대상 디렉토리 (기본: 프로젝트 루트)
 */
function runNpmAudit(cwd = config.ROOT) {
  try {
    const raw = execSync('npm audit --json --audit-level=low 2>/dev/null', {
      cwd,
      timeout: config.THRESHOLDS.auditTimeout,
      encoding: 'utf8',
    });
    return _parseAuditJson(raw);
  } catch (e) {
    // npm audit는 취약점 발견 시 exit code 1 — stdout에 JSON 존재
    if (e.stdout) {
      try { return _parseAuditJson(e.stdout); } catch { /* fall */ }
    }
    return { vulnerabilities: {}, total: 0, summary: {}, error: e.message?.slice(0, 200) };
  }
}

function _parseAuditJson(raw) {
  const data  = JSON.parse(raw);
  const vulns = data.vulnerabilities || {};
  const summary = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const v of Object.values(vulns)) {
    const sev = v.severity || 'info';
    if (sev in summary) summary[sev]++;
  }
  return { vulnerabilities: vulns, total: Object.keys(vulns).length, summary, error: null };
}

// ─── 웹 소스 (RSS / HTML) ────────────────────────────────────────────

/**
 * RSS XML 간단 파싱 → 최신 항목 최대 5개
 */
function parseRss(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null && items.length < 5) {
    const content = m[1];
    const getTag  = (tag) =>
      (new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(content) ||
       new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(content) || [])[1] || '';

    const title   = getTag('title').replace(/<[^>]+>/g, '').trim();
    const link    = getTag('link').trim() || (/<link\s[^>]*href="([^"]+)"/i.exec(content) || [])[1] || '';
    const pubDate = (getTag('pubDate') || getTag('published') || getTag('updated')).trim();

    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

/**
 * 단일 웹 소스 수집
 */
async function fetchWebSource(source) {
  const { id, label, type, url } = source;
  try {
    const raw = await httpsGet(url, config.THRESHOLDS.webTimeout);
    const items = type === 'rss' ? parseRss(raw) : [];
    return { id, label, items, error: null };
  } catch (e) {
    return { id, label, items: [], error: e.message };
  }
}

/**
 * 전체 웹 소스 수집
 */
async function fetchAllWebSources() {
  return Promise.all(config.WEB_SOURCES.map(s => fetchWebSource(s)));
}

// ─── 내부 유틸 ────────────────────────────────────────────────────────

function loadGithubToken() {
  for (const p of config.SECRETS_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s?.github_token) return s.github_token;
    } catch { /* 무시 */ }
  }
  return process.env.GITHUB_TOKEN || null;
}

// ─── 통합 수집 ────────────────────────────────────────────────────────

/**
 * 전체 데이터 수집
 * @param {object} opts { skipWeb, skipAudit }
 */
async function fetchAll(opts = {}) {
  console.log('  📡 [아처] GitHub + npm 수집 중...');
  const [github, npm] = await Promise.all([
    fetchAllGithub(),
    fetchAllNpm(),
  ]);
  const packageUsage = fetchPackageUsage(config.NPM.PACKAGES);

  let webSources = [];
  if (!opts.skipWeb) {
    console.log('  🌐 [아처] 웹 소스 수집 중...');
    webSources = await fetchAllWebSources();
  }

  let audit = { vulnerabilities: {}, total: 0, summary: {}, error: null };
  if (!opts.skipAudit) {
    console.log('  🔍 [아처] npm audit 실행 중...');
    audit = runNpmAudit();
  }

  return { github, npm, webSources, audit, packageUsage };
}

module.exports = {
  fetchGithubRelease, fetchAllGithub,
  fetchNpmVersion, fetchAllNpm,
  fetchPackageUsage,
  fetchWebSource, fetchAllWebSources,
  runNpmAudit,
  fetchAll,
};
