#!/usr/bin/env tsx
// @ts-nocheck

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setProviderCanary, setProviderToken } = require('../lib/oauth/token-store.ts');

function resolveUserPath(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function defaultAdcPath() {
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--adc-file') out.adcFile = argv[++index];
    else if (arg === '--project-id') out.projectId = argv[++index];
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseExpiryMs(payload) {
  const raw = payload?.expiry || payload?.expires_at || payload?.expiresAt;
  if (!raw) return NaN;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : NaN;
}

async function refreshAuthorizedUserCredential(adc, tokenUrl) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: String(adc.refresh_token || ''),
    client_id: String(adc.client_id || ''),
    client_secret: String(adc.client_secret || ''),
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(payload?.error_description || payload?.error?.message || payload?.error || `http_${response.status}`).slice(0, 240);
    throw new Error(`gemini_adc_refresh_failed:${message}`);
  }
  if (!payload?.access_token) {
    throw new Error('gemini_adc_refresh_missing_access_token');
  }
  const expiresIn = Number(payload.expires_in || 3600);
  return {
    access_token: String(payload.access_token),
    refresh_token: String(adc.refresh_token || ''),
    token_type: String(payload.token_type || 'Bearer'),
    expires_at: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
    ...(payload.scope ? { scope: String(payload.scope) } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const adcFile = resolveUserPath(
    args.adcFile
      || process.env.GEMINI_OAUTH_ADC_FILE
      || process.env.GOOGLE_APPLICATION_CREDENTIALS
      || defaultAdcPath(),
  );
  if (!adcFile || !fs.existsSync(adcFile)) {
    throw new Error(`missing_adc_file:${adcFile || 'not_configured'}`);
  }

  const adc = readJson(adcFile);
  if (adc.type && adc.type !== 'authorized_user') {
    throw new Error(`unsupported_adc_type:${adc.type}`);
  }
  if (!adc.refresh_token || !adc.client_id || !adc.client_secret) {
    throw new Error('adc_authorized_user_fields_missing');
  }

  const quotaProjectId = String(
    args.projectId
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || adc.quota_project_id
      || '',
  ).trim();
  if (!quotaProjectId) {
    throw new Error('missing_quota_project');
  }

  const tokenUrl = String(process.env.GEMINI_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token');
  const token = await refreshAuthorizedUserCredential(adc, tokenUrl);
  const existingExpiryMs = parseExpiryMs(adc);
  const metadata = {
    provider: 'gemini-oauth',
    source: 'google_application_default_credentials',
    imported_by: 'gemini_oauth_adc_import',
    imported_at: new Date().toISOString(),
    adc_path: adcFile,
    quota_project_id: quotaProjectId,
    runtime_enabled: true,
    ...(Number.isFinite(existingExpiryMs) ? { adc_previous_expiry: new Date(existingExpiryMs).toISOString() } : {}),
  };

  if (!args.dryRun) {
    setProviderToken('gemini-oauth', token, metadata);
    setProviderCanary('gemini-oauth', {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: token.expires_at,
        quota_project_configured: true,
        imported_by: metadata.imported_by,
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    provider: 'gemini-oauth',
    dry_run: Boolean(args.dryRun),
    source: metadata.source,
    adc_file: adcFile,
    quota_project_configured: true,
    expires_at: token.expires_at,
  }, null, 2));
}

main().catch((error) => {
  console.error('[gemini-oauth-adc-import] failed:', error?.message || error);
  process.exitCode = 1;
});
