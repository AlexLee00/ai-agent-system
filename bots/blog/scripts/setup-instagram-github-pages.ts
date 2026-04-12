'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    owner: readOption(argv, '--owner'),
    repo: readOption(argv, '--repo'),
    baseUrl: readOption(argv, '--base-url'),
    prefix: readOption(argv, '--public-relative-prefix') || 'blog-assets/instagram',
  };
}

function readOption(argv = [], flag = '') {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] || '' : '';
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function parseGitHubRemote(remoteUrl = '') {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

function inferGitHubPagesBaseUrl(args) {
  if (args.baseUrl) return args.baseUrl.replace(/\/+$/, '');
  const explicitOwner = args.owner || '';
  const explicitRepo = args.repo || '';
  if (explicitOwner && explicitRepo) {
    return `https://${explicitOwner}.github.io/${explicitRepo}`;
  }

  const remoteUrl = execFileSync('git', ['-C', env.PROJECT_ROOT, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    throw new Error(`GitHub origin URL을 해석하지 못했습니다: ${remoteUrl}`);
  }
  return `https://${parsed.owner}.github.io/${parsed.repo}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const githubPagesBaseUrl = inferGitHubPagesBaseUrl(args);
  const current = loadStore();
  const next = {
    ...current,
    instagram: {
      ...(current.instagram || {}),
      host_mode: 'github_pages',
      github_pages_base_url: githubPagesBaseUrl,
      public_relative_prefix: args.prefix,
    },
  };

  if (!args.dryRun) {
    saveStore(next);
  }

  const payload = {
    dryRun: args.dryRun,
    storePath: STORE_PATH,
    instagram: {
      host_mode: 'github_pages',
      github_pages_base_url: githubPagesBaseUrl,
      public_relative_prefix: args.prefix,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 GH Pages] ${args.dryRun ? 'dry-run' : 'saved'}: ${STORE_PATH}`);
  console.log(`[인스타 GH Pages] base=${githubPagesBaseUrl}`);
}

main();
