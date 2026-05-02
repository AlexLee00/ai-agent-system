#!/usr/bin/env tsx
// @ts-nocheck

const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
const { getProviderRecord } = require('../lib/oauth/token-store.ts');
const {
  checkGeminiCodeAssistServiceStatus,
} = require('../lib/oauth/gemini-codeassist-service-status.ts');

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-id') out.projectId = argv[++index];
    else if (arg === '--credentials-file') out.credentialsFile = argv[++index];
    else if (arg === '--json') out.json = true;
    else if (arg === '--require-live') out.requireLive = true;
  }
  return out;
}

function projectFromRecord(record) {
  return String(
    record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || '',
  ).trim();
}

async function main() {
  const args = parseArgs(process.argv);
  const record = getProviderRecord('gemini-cli-oauth');
  const projectId = String(
    args.projectId
      || process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || projectFromRecord(record)
      || '',
  ).trim();
  const credentials = readGeminiCliCredentials({
    credentialsFile: args.credentialsFile || record?.metadata?.credential_path,
    projectId,
  });

  let status = null;
  if (credentials.ok) {
    status = await checkGeminiCodeAssistServiceStatus({
      projectId,
      accessToken: credentials.token?.access_token,
    });
  }

  const ok = Boolean(credentials.ok && status?.ok);
  const payload = {
    ok,
    provider: 'gemini-cli-oauth',
    service: 'cloudaicompanion.googleapis.com',
    generated_at: new Date().toISOString(),
    project_id_configured: Boolean(projectId),
    credentials: {
      ok: Boolean(credentials.ok),
      source: credentials.source || null,
      quota_project_configured: Boolean(credentials.quota_project_configured || projectId),
      expires_at: credentials.token?.expires_at || null,
      identity_present: Boolean(credentials.metadata?.identity_present),
      error: credentials.ok ? null : credentials.error || 'gemini_cli_credentials_unavailable',
    },
    service_status: status,
    next_actions: ok ? [] : [
      ...(!projectId ? ['Set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT.'] : []),
      ...(!credentials.ok ? ['Run gemini auth login or import Gemini CLI OAuth credentials.'] : []),
      ...(status?.activation_url ? [`Enable required Google API: ${status.activation_url}`] : []),
      ...(status?.operator_action ? [status.operator_action] : []),
    ],
    notes: [
      'No access token, refresh token, account id, or raw secret is included in this report.',
    ],
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = ok || !args.requireLive ? 0 : 1;
}

main().catch((error) => {
  console.error('[gemini-codeassist-service-status] failed:', error?.message || error);
  process.exitCode = 1;
});
