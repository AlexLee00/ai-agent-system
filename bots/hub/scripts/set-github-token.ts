import fs from 'node:fs';
import path from 'node:path';
import env from '../../../packages/core/lib/env.legacy.js';

const githubPat = require('../../../packages/core/lib/github-pat-renewal');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

type Args = {
  token: string;
  tokenName: string;
  targetName: string;
  expiresAt: string;
  repositories: string;
  permissions: string;
  permissionPreset: string;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    token: '',
    tokenName: '',
    targetName: '',
    expiresAt: '',
    repositories: '',
    permissions: '',
    permissionPreset: '',
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--token') args.token = argv[++i] || '';
    else if (token === '--token-name') args.tokenName = argv[++i] || '';
    else if (token === '--target-name' || token === '--owner') args.targetName = argv[++i] || '';
    else if (token === '--expires-at') args.expiresAt = argv[++i] || '';
    else if (token === '--repositories') args.repositories = argv[++i] || '';
    else if (token === '--permissions') args.permissions = argv[++i] || '';
    else if (token === '--permission-preset') args.permissionPreset = argv[++i] || '';
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
  }

  return args;
}

function loadStore(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    throw new Error('--token is required');
  }

  const permissions = githubPat.mergePermissions(
    githubPat.resolvePermissionPreset(args.permissionPreset),
    githubPat.parsePermissionPairs(args.permissions),
  );
  const repositories = githubPat.parseRepositories(args.repositories);
  const store = loadStore();
  const currentGithub = (store.github && typeof store.github === 'object' && !Array.isArray(store.github))
    ? (store.github as Record<string, unknown>)
    : {};

  const nextGithub = {
    ...currentGithub,
    token: args.token,
    token_name: args.tokenName || currentGithub.token_name || '',
    target_name: args.targetName || currentGithub.target_name || '',
    expires_at: args.expiresAt || currentGithub.expires_at || '',
    repositories,
    permissions,
    updated_at: new Date().toISOString(),
    source: 'github_fine_grained_pat_manual_generation',
  };

  const nextStore = {
    ...store,
    github: nextGithub,
  };

  const payload = {
    ok: true,
    dryRun: args.dryRun,
    storePath: STORE_PATH,
    stored: {
      hasToken: Boolean(nextGithub.token),
      tokenName: nextGithub.token_name,
      targetName: nextGithub.target_name,
      expiresAt: nextGithub.expires_at,
      repositories,
      permissions,
      permissionSummary: githubPat.summarizePermissions(permissions),
      updatedAt: nextGithub.updated_at,
    },
    nextSteps: [
      'Run github:token-smoke to verify repo access.',
      'Update any dependent runtime that still uses an old PAT.',
      'Revoke the old PAT in GitHub after smoke checks pass.',
    ],
  };

  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, `${JSON.stringify(nextStore, null, 2)}\n`, 'utf8');
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[github token] ${args.dryRun ? 'dry-run' : 'saved'}: ${STORE_PATH}`);
  console.log(`[github token] name=${payload.stored.tokenName || '(unset)'} owner=${payload.stored.targetName || '(unset)'}`);
  console.log(`[github token] repos=${repositories.join(', ') || '(not recorded)'}`);
  console.log(`[github token] permissions=${payload.stored.permissionSummary.join(', ') || '(not recorded)'}`);
}

main();
