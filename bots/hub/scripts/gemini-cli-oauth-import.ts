#!/usr/bin/env tsx
// @ts-nocheck

const {
  readGeminiCliCredentials,
} = require('../lib/oauth/gemini-cli-credentials.ts');
const { setProviderCanary, setProviderToken } = require('../lib/oauth/token-store.ts');

function parseArgs(argv) {
  const out = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--credentials-file') out.credentialsFile = argv[++index];
    else if (arg === '--project-id') out.projectId = argv[++index];
    else if (arg === '--provider') out.provider = argv[++index];
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const provider = String(args.provider || 'gemini-cli-oauth').trim() || 'gemini-cli-oauth';
  const imported = readGeminiCliCredentials({
    credentialsFile: args.credentialsFile,
    projectId: args.projectId,
    provider,
  });
  if (!imported.ok) {
    throw new Error(`${imported.error}:${imported.filePath || 'not_configured'}`);
  }

  const metadata = {
    ...(imported.metadata || {}),
    imported_by: 'gemini_cli_oauth_import',
    imported_at: new Date().toISOString(),
  };

  if (!args.dryRun) {
    setProviderToken(provider, imported.token, metadata);
    setProviderCanary(provider, {
      ok: true,
      details: {
        source: metadata.source,
        expires_at: imported.token.expires_at,
        quota_project_configured: imported.quota_project_configured,
        imported_by: metadata.imported_by,
        identity_present: Boolean(metadata.identity_present),
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    provider,
    source: imported.source,
    dry_run: Boolean(args.dryRun),
    credentials_file: imported.filePath,
    expires_at: imported.token.expires_at,
    quota_project_configured: imported.quota_project_configured,
    identity_present: Boolean(metadata.identity_present),
    account_email_domain: metadata.account_email_domain || null,
  }, null, 2));
}

main().catch((error) => {
  console.error('[gemini-cli-oauth-import] failed:', error?.message || error);
  process.exitCode = 1;
});
