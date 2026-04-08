'use strict';

const GITHUB_API = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 15_000;
const RATE_DELAY_MS = 1_000;

let _cachedToken = null;

function _getToken() {
  if (_cachedToken !== null) return _cachedToken;
  try {
    const hubClient = require('./hub-client');
    const secrets = hubClient._secretsCache || {};
    _cachedToken = secrets?.github?.token || process.env.GITHUB_TOKEN || '';
  } catch {
    _cachedToken = process.env.GITHUB_TOKEN || '';
  }
  return _cachedToken;
}

function _headers() {
  const h = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'team-jay' };
  const token = _getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getRepoInfo(owner, repo) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${owner}/${repo}`);
  const d = await res.json();
  return {
    name: d.full_name, description: d.description, stars: d.stargazers_count,
    language: d.language, license: d.license?.spdx_id, default_branch: d.default_branch,
    updated_at: d.updated_at, topics: d.topics || [],
  };
}

async function listDir(owner, repo, dirPath = '', branch) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}${branch ? `?ref=${branch}` : ''}`;
  const res = await fetch(url, { headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${dirPath}`);
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  return items.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size || 0 }));
}

async function readFile(owner, repo, filePath, branch, maxLines = 300) {
  const ref = branch || 'main';
  const url = `${RAW_BASE}/${owner}/${repo}/${ref}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${filePath}`);
  const content = await res.text();
  const lines = content.split('\n');
  return {
    path: filePath, size: content.length, totalLines: lines.length,
    content: lines.slice(0, maxLines).join('\n'), truncated: lines.length > maxLines,
  };
}

async function getTree(owner, repo, branch) {
  const ref = branch || 'main';
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
    headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: tree`);
  const data = await res.json();
  return (data.tree || []).map(t => ({ path: t.path, type: t.type, size: t.size || 0 }));
}

async function readFiles(owner, repo, filePaths, branch, maxLinesPerFile = 200) {
  const results = [];
  for (const fp of filePaths) {
    try {
      const file = await readFile(owner, repo, fp, branch, maxLinesPerFile);
      results.push(file);
    } catch (err) {
      results.push({ path: fp, error: err.message });
    }
    await _sleep(RATE_DELAY_MS);
  }
  return results;
}

module.exports = { getRepoInfo, listDir, readFile, getTree, readFiles };
