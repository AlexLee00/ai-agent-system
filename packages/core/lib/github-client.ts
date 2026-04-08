const GITHUB_API = 'https://api.github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 15_000;
const RATE_DELAY_MS = 1_000;

type HubClientLike = {
  _secretsCache?: {
    github?: {
      token?: string;
    };
  };
};

type RepoInfo = {
  name: string;
  description: unknown;
  stars: number;
  language: unknown;
  license: unknown;
  default_branch: string;
  updated_at?: string;
  topics: unknown[];
};

type DirItem = {
  name: string;
  path: string;
  type: string;
  size: number;
};

type ReadFileResult = {
  path: string;
  size: number;
  totalLines: number;
  content: string;
  truncated: boolean;
};

type TreeItem = {
  path: string;
  type: string;
  size: number;
};

type ReadFilesResult = ReadFileResult | { path: string; error: string };

let _cachedToken: string | null = null;

function _getToken(): string {
  if (_cachedToken !== null) return _cachedToken;
  try {
    const hubClient = require('./hub-client') as HubClientLike;
    const secrets = hubClient._secretsCache || {};
    _cachedToken = secrets?.github?.token || process.env.GITHUB_TOKEN || '';
  } catch {
    _cachedToken = process.env.GITHUB_TOKEN || '';
  }
  return _cachedToken;
}

function _headers(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'team-jay',
  };
  const token = _getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getRepoInfo(owner: string, repo: string): Promise<RepoInfo> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: _headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${owner}/${repo}`);
  const d = await res.json() as Record<string, unknown>;
  return {
    name: String(d.full_name || ''),
    description: d.description,
    stars: Number(d.stargazers_count || 0),
    language: d.language,
    license: (d.license as { spdx_id?: unknown } | undefined)?.spdx_id,
    default_branch: String(d.default_branch || 'main'),
    updated_at: typeof d.updated_at === 'string' ? d.updated_at : undefined,
    topics: Array.isArray(d.topics) ? d.topics : [],
  };
}

async function listDir(owner: string, repo: string, dirPath = '', branch?: string): Promise<DirItem[]> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}${branch ? `?ref=${branch}` : ''}`;
  const res = await fetch(url, { headers: _headers(), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${dirPath}`);
  const items = await res.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    name: String(item.name || ''),
    path: String(item.path || ''),
    type: String(item.type || ''),
    size: Number(item.size || 0),
  }));
}

async function readFile(owner: string, repo: string, filePath: string, branch?: string, maxLines = 300): Promise<ReadFileResult> {
  const ref = branch || 'main';
  const url = `${RAW_BASE}/${owner}/${repo}/${ref}/${filePath}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${filePath}`);
  const content = await res.text();
  const lines = content.split('\n');
  return {
    path: filePath,
    size: content.length,
    totalLines: lines.length,
    content: lines.slice(0, maxLines).join('\n'),
    truncated: lines.length > maxLines,
  };
}

async function getTree(owner: string, repo: string, branch?: string): Promise<TreeItem[]> {
  const ref = branch || 'main';
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, {
    headers: _headers(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: tree`);
  const data = await res.json() as { tree?: Array<Record<string, unknown>> };
  return (data.tree || []).map((item) => ({
    path: String(item.path || ''),
    type: String(item.type || ''),
    size: Number(item.size || 0),
  }));
}

async function readFiles(
  owner: string,
  repo: string,
  filePaths: string[],
  branch?: string,
  maxLinesPerFile = 200,
): Promise<ReadFilesResult[]> {
  const results: ReadFilesResult[] = [];
  for (const fp of filePaths) {
    try {
      const file = await readFile(owner, repo, fp, branch, maxLinesPerFile);
      results.push(file);
    } catch (error) {
      results.push({ path: fp, error: (error as Error).message });
    }
    await _sleep(RATE_DELAY_MS);
  }
  return results;
}

export = { getRepoInfo, listDir, readFile, getTree, readFiles };
