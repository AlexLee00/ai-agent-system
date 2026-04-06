'use strict';

/**
 * GitHub REST API 클라이언트
 * 다윈팀 scholar/edison이 외부 레포 소스 코드 분석에 사용
 * public repo: 인증 없이 60req/hr
 * GITHUB_TOKEN 설정 시: 5000req/hr
 */

const GITHUB_API = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 15_000;
const RATE_DELAY_MS = 1_000;

function _headers() {
  const h = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'team-jay' };
  const token = process.env.GITHUB_TOKEN || '';
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 레포 기본 정보
 * @param {string} owner - 소유자 (예: 'freqtrade')
 * @param {string} repo - 레포명 (예: 'freqtrade')
 * @returns {Promise<{name, description, stars, language, license, default_branch, topics}>}
 */
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

/**
 * 디렉토리 목록
 * @param {string} owner
 * @param {string} repo
 * @param {string} dirPath - 경로 (예: 'freqtrade/optimize')
 * @param {string} [branch]
 * @returns {Promise<Array<{name, path, type, size}>>}
 */
async function listDir(owner, repo, dirPath = '', branch) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}${branch ? `?ref=${branch}` : ''}`;
  const res = await fetch(url, { headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${dirPath}`);
  const items = await res.json();
  if (!Array.isArray(items)) return [];
  return items.map(i => ({ name: i.name, path: i.path, type: i.type, size: i.size || 0 }));
}

/**
 * 파일 내용 읽기
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath
 * @param {string} [branch]
 * @param {number} [maxLines=300] - 최대 줄 수
 * @returns {Promise<{path, size, totalLines, content, truncated}>}
 */
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

/**
 * 레포 전체 트리 (1회 API 호출로 전체 구조!)
 * @param {string} owner
 * @param {string} repo
 * @param {string} [branch]
 * @returns {Promise<Array<{path, type, size}>>}
 */
async function getTree(owner, repo, branch) {
  const ref = branch || 'main';
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
    headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: tree`);
  const data = await res.json();
  return (data.tree || []).map(t => ({ path: t.path, type: t.type, size: t.size || 0 }));
}

/**
 * 다중 파일 읽기 (rate limit 준수)
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} filePaths
 * @param {string} [branch]
 * @param {number} [maxLinesPerFile=200]
 * @returns {Promise<Array<{path, size?, totalLines?, content?, truncated?, error?}>>}
 */
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
