import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import env from '../../../packages/core/lib/env.legacy.js';

const githubPat = require('../../../packages/core/lib/github-pat-renewal');

const OUTPUT_DIR = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'output', 'ops');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'github-pat-renewal-latest.json');

type Args = {
  tokenName: string;
  description: string;
  targetName: string;
  expiresIn: string;
  permissionPreset: string;
  permissions: string;
  repositories: string;
  openBrowser: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    tokenName: 'team-jay-github-token',
    description: 'GitHub MCP automation token',
    targetName: '',
    expiresIn: '30',
    permissionPreset: 'repo_write_pr',
    permissions: '',
    repositories: '',
    openBrowser: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--token-name') args.tokenName = argv[++i] || args.tokenName;
    else if (token === '--description') args.description = argv[++i] || args.description;
    else if (token === '--target-name' || token === '--owner') args.targetName = argv[++i] || args.targetName;
    else if (token === '--expires-in') args.expiresIn = argv[++i] || args.expiresIn;
    else if (token === '--permission-preset') args.permissionPreset = argv[++i] || args.permissionPreset;
    else if (token === '--permissions') args.permissions = argv[++i] || args.permissions;
    else if (token === '--repositories') args.repositories = argv[++i] || args.repositories;
    else if (token === '--open-browser') args.openBrowser = true;
    else if (token === '--json') args.json = true;
  }

  return args;
}

function writeTelemetry(payload: unknown): void {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function openBrowser(url: string): { ok: boolean; error?: string } {
  try {
    execFileSync('/usr/bin/open', [url], { stdio: 'ignore' });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const permissions = githubPat.mergePermissions(
    githubPat.resolvePermissionPreset(args.permissionPreset),
    githubPat.parsePermissionPairs(args.permissions),
  );
  const repositories = githubPat.parseRepositories(args.repositories);
  const prefillUrl = githubPat.buildGitHubPatPrefillUrl({
    name: args.tokenName,
    description: args.description,
    targetName: args.targetName,
    expiresIn: args.expiresIn,
    permissions,
  });

  const payload = {
    ok: true,
    tokenName: args.tokenName,
    description: args.description,
    targetName: args.targetName || '(current-user-default)',
    expiresIn: githubPat.clampExpiration(args.expiresIn),
    repositories,
    repositorySelectionNote: repositories.length > 0
      ? 'GitHub URL prefill cannot auto-select repositories; choose these repos manually in the form.'
      : 'If you need repo-scoped access, choose repositories manually in the form.',
    permissionPreset: args.permissionPreset,
    permissions,
    permissionSummary: githubPat.summarizePermissions(permissions),
    prefillUrl,
    browserOpened: false,
    nextSteps: [
      'Open the prefilled GitHub fine-grained token page.',
      'Generate the token in GitHub UI and copy the token value once.',
      'Run npm --prefix bots/hub run github:set-token -- --token <NEW_TOKEN> --token-name "<NAME>" --target-name "<OWNER>" --expires-at <ISO8601> --json',
      'Run npm --prefix bots/hub run github:token-smoke -- --owner <OWNER> --repo <REPO> --json',
    ],
    source: {
      docs: [
        'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
        'https://docs.github.com/en/rest/orgs/personal-access-tokens',
      ],
    },
  };

  if (args.openBrowser) {
    const opened = openBrowser(prefillUrl);
    payload.browserOpened = opened.ok;
    if (!opened.ok) payload['browserOpenError'] = opened.error || 'failed_to_open_browser';
  }

  writeTelemetry(payload);

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[github pat] prepared: ${args.tokenName}`);
  console.log(`[github pat] owner=${payload.targetName} expires_in=${payload.expiresIn}d browser=${payload.browserOpened ? 'opened' : 'not-opened'}`);
  console.log(`[github pat] permissions=${payload.permissionSummary.join(', ') || 'none'}`);
  if (repositories.length > 0) {
    console.log(`[github pat] repositories=${repositories.join(', ')}`);
    console.log('[github pat] note=select repositories manually in GitHub form');
  }
  console.log(`[github pat] url=${prefillUrl}`);
}

main();
