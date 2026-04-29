import fs from 'node:fs';
import path from 'node:path';
import env from '../../../packages/core/lib/env.legacy.js';

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const GITHUB_API = 'https://api.github.com';

type Args = {
  org: string;
  action: 'list' | 'approve' | 'deny';
  requestIds: string;
  reason: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    org: '',
    action: 'list',
    requestIds: '',
    reason: '',
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--org') args.org = argv[++i] || '';
    else if (token === '--action') args.action = (argv[++i] as Args['action']) || 'list';
    else if (token === '--request-ids') args.requestIds = argv[++i] || '';
    else if (token === '--reason') args.reason = argv[++i] || '';
    else if (token === '--json') args.json = true;
  }

  return args;
}

function loadStore(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadAppToken(): string {
  const envToken = String(process.env.GITHUB_APP_TOKEN || '').trim();
  if (envToken) return envToken;
  const store = loadStore();
  return String(store?.github_app?.app_token || '').trim();
}

async function githubFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'team-jay-github-pat-review',
      'X-GitHub-Api-Version': '2026-03-10',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
}

async function parseJsonSafe(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRequestIds(raw: string): number[] {
  return raw
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function listPending(org: string, token: string) {
  const res = await githubFetch(`${GITHUB_API}/orgs/${org}/personal-access-token-requests`, token);
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new Error(typeof data === 'object' && data ? String(data.message || JSON.stringify(data)) : `HTTP ${res.status}`);
  }
  return Array.isArray(data) ? data : [];
}

async function reviewBulk(org: string, token: string, requestIds: number[], action: 'approve' | 'deny', reason: string) {
  const res = await githubFetch(`${GITHUB_API}/orgs/${org}/personal-access-token-requests`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pat_request_ids: requestIds,
      action,
      ...(reason ? { reason } : {}),
    }),
  });
  const data = await parseJsonSafe(res);
  if (![202, 204].includes(res.status)) {
    throw new Error(typeof data === 'object' && data ? String(data.message || JSON.stringify(data)) : `HTTP ${res.status}`);
  }
  return { status: res.status, body: data };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.org) throw new Error('--org is required');
  const token = loadAppToken();
  if (!token) {
    throw new Error('GitHub App token missing. Set GITHUB_APP_TOKEN or store github_app.app_token in Hub secrets.');
  }

  if (args.action === 'list') {
    const requests = await listPending(args.org, token);
    const payload = {
      ok: true,
      org: args.org,
      action: 'list',
      count: requests.length,
      requests: requests.map((item: any) => ({
        id: item.id,
        tokenName: item.token_name || '',
        owner: item.owner?.login || '',
        createdAt: item.created_at || '',
        permissions: item.permissions || {},
      })),
    };
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(`[github pat review] org=${args.org} pending=${payload.count}`);
    for (const item of payload.requests) {
      console.log(`- #${item.id} ${item.owner}/${item.tokenName}`);
    }
    return;
  }

  const requestIds = parseRequestIds(args.requestIds);
  if (requestIds.length === 0) throw new Error('--request-ids is required for approve/deny');
  const result = await reviewBulk(args.org, token, requestIds, args.action, args.reason);
  const payload = {
    ok: true,
    org: args.org,
    action: args.action,
    requestIds,
    status: result.status,
    reason: args.reason,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[github pat review] org=${args.org} action=${args.action} ids=${requestIds.join(',')} status=${result.status}`);
}

main().catch((error) => {
  console.error('[github-pat-request-review] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
