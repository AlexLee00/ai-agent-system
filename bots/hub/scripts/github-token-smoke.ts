import fs from 'node:fs';
import path from 'node:path';
import env from '../../../packages/core/lib/env.legacy.js';

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

type Args = {
  owner: string;
  repo: string;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    owner: '',
    repo: '',
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--owner') args.owner = argv[++i] || '';
    else if (token === '--repo') args.repo = argv[++i] || '';
    else if (token === '--json') args.json = true;
  }

  return args;
}

function loadToken(): string {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { github?: { token?: string } };
    return String(store?.github?.token || '').trim();
  } catch {
    return '';
  }
}

async function fetchJson(url: string, token: string): Promise<{ ok: boolean; status: number; data?: any; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'team-jay-github-token-smoke',
      },
      signal: AbortSignal.timeout(15000),
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: typeof data === 'object' && data ? String(data.message || JSON.stringify(data)) : String(data || `HTTP ${res.status}`),
      };
    }

    return { ok: true, status: res.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = loadToken();
  if (!token) {
    throw new Error(`github token missing in ${STORE_PATH}`);
  }

  const userResult = await fetchJson('https://api.github.com/user', token);
  const repoUrl = args.owner && args.repo ? `https://api.github.com/repos/${args.owner}/${args.repo}` : '';
  const repoResult = repoUrl ? await fetchJson(repoUrl, token) : null;

  const payload = {
    ok: userResult.ok && (!repoResult || repoResult.ok),
    authenticated: userResult.ok,
    login: userResult.ok ? String(userResult.data?.login || '') : '',
    tokenSource: STORE_PATH,
    repoCheck: repoResult
      ? {
          owner: args.owner,
          repo: args.repo,
          ok: repoResult.ok,
          status: repoResult.status,
          fullName: repoResult.ok ? String(repoResult.data?.full_name || '') : '',
          error: repoResult.ok ? '' : repoResult.error || '',
        }
      : null,
    error: userResult.ok ? '' : userResult.error || '',
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[github token smoke] auth=${payload.authenticated ? 'ok' : 'fail'} login=${payload.login || '-'}`);
  if (payload.repoCheck) {
    console.log(`[github token smoke] repo=${payload.repoCheck.owner}/${payload.repoCheck.repo} ${payload.repoCheck.ok ? 'ok' : `fail:${payload.repoCheck.error}`}`);
  }
  if (payload.error) console.log(`[github token smoke] error=${payload.error}`);
}

main().catch((error) => {
  console.error('[github-token-smoke] failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
