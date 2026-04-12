// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');

function parseArgs(argv = []) {
  const args = {
    accessToken: '',
    igUserId: '',
    appId: '',
    appSecret: '',
    businessAccountId: '',
    tokenExpiresAt: '',
    apiVersion: 'v21.0',
    baseUrl: 'https://graph.facebook.com',
    hostMode: '',
    githubPagesBaseUrl: '',
    publicBaseUrl: '',
    opsStaticBaseUrl: '',
    publicRelativePrefix: 'blog-assets/instagram',
    clearTokenExpiresAt: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--access-token') args.accessToken = argv[++i] || '';
    else if (token === '--ig-user-id') args.igUserId = argv[++i] || '';
    else if (token === '--app-id') args.appId = argv[++i] || '';
    else if (token === '--app-secret') args.appSecret = argv[++i] || '';
    else if (token === '--business-account-id') args.businessAccountId = argv[++i] || '';
    else if (token === '--token-expires-at') args.tokenExpiresAt = argv[++i] || '';
    else if (token === '--api-version') args.apiVersion = argv[++i] || 'v21.0';
    else if (token === '--base-url') args.baseUrl = argv[++i] || 'https://graph.facebook.com';
    else if (token === '--host-mode') args.hostMode = argv[++i] || '';
    else if (token === '--github-pages-base-url') args.githubPagesBaseUrl = argv[++i] || '';
    else if (token === '--public-base-url') args.publicBaseUrl = argv[++i] || '';
    else if (token === '--ops-static-base-url') args.opsStaticBaseUrl = argv[++i] || '';
    else if (token === '--public-relative-prefix') args.publicRelativePrefix = argv[++i] || 'blog-assets/instagram';
    else if (token === '--clear-token-expires-at') args.clearTokenExpiresAt = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--json') args.json = true;
  }

  return args;
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function sanitizeInstagramSection(args) {
  const section = {};
  if (args.accessToken) section.access_token = args.accessToken;
  if (args.igUserId) section.ig_user_id = args.igUserId;
  if (args.appId) section.app_id = args.appId;
  if (args.appSecret) section.app_secret = args.appSecret;
  if (args.businessAccountId) section.business_account_id = args.businessAccountId;
  if (args.tokenExpiresAt) section.token_expires_at = args.tokenExpiresAt;
  if (args.clearTokenExpiresAt) section.token_expires_at = null;
  section.api_version = args.apiVersion || 'v21.0';
  section.base_url = args.baseUrl || 'https://graph.facebook.com';
  if (args.hostMode) section.host_mode = args.hostMode;
  if (args.githubPagesBaseUrl) section.github_pages_base_url = args.githubPagesBaseUrl;
  if (args.publicBaseUrl) section.public_base_url = args.publicBaseUrl;
  if (args.opsStaticBaseUrl) section.ops_static_base_url = args.opsStaticBaseUrl;
  if (args.publicRelativePrefix) section.public_relative_prefix = args.publicRelativePrefix;
  return section;
}

function ensureDirectory() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const current = loadStore();
  const currentInstagram = current.instagram || {};
  const nextInstagram = {
    ...currentInstagram,
    ...sanitizeInstagramSection(args),
  };

  const nextStore = {
    ...current,
    instagram: nextInstagram,
  };

  const payload = {
    storePath: STORE_PATH,
    dryRun: args.dryRun,
    source: 'hub_store',
    updated: {
      has_access_token: Boolean(nextInstagram.access_token),
      has_ig_user_id: Boolean(nextInstagram.ig_user_id),
      has_app_id: Boolean(nextInstagram.app_id),
      has_app_secret: Boolean(nextInstagram.app_secret),
      has_business_account_id: Boolean(nextInstagram.business_account_id),
      token_expires_at: nextInstagram.token_expires_at || '',
      api_version: nextInstagram.api_version || 'v21.0',
      base_url: nextInstagram.base_url || 'https://graph.facebook.com',
      host_mode: nextInstagram.host_mode || '',
      github_pages_base_url: nextInstagram.github_pages_base_url || '',
      public_base_url: nextInstagram.public_base_url || '',
      ops_static_base_url: nextInstagram.ops_static_base_url || '',
      public_relative_prefix: nextInstagram.public_relative_prefix || 'blog-assets/instagram',
    },
    nextSteps: [
      'check:instagram-token',
      'refresh:instagram-token',
      'publish-instagram-reel',
    ],
  };

  if (!args.dryRun) {
    ensureDirectory();
    fs.writeFileSync(STORE_PATH, JSON.stringify(nextStore, null, 2));
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`[인스타 secret] ${args.dryRun ? 'dry-run' : 'saved'} (hub store): ${STORE_PATH}`);
  console.log(`[인스타 secret] token=${payload.updated.has_access_token ? 'configured' : 'missing'} ig_user_id=${payload.updated.has_ig_user_id ? 'configured' : 'missing'} app_id=${payload.updated.has_app_id ? 'configured' : 'missing'} app_secret=${payload.updated.has_app_secret ? 'configured' : 'missing'}`);
  console.log(`[인스타 secret] next=${payload.nextSteps.join(' -> ')}`);
}

main();
