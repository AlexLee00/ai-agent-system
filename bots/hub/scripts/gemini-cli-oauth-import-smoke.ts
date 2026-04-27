#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function b64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function fakeJwt(payload: unknown): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.`;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-gemini-cli-oauth-import-'));
  const credentialsFile = path.join(tempRoot, '.gemini', 'oauth_creds.json');
  const tokenStoreFile = path.join(tempRoot, 'token-store.json');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  fs.writeFileSync(credentialsFile, `${JSON.stringify({
    access_token: 'gemini-cli-access-token-secret',
    refresh_token: 'gemini-cli-refresh-token-secret',
    expiry_date: Date.now() + 60 * 60 * 1000,
    token_type: 'Bearer',
    id_token: fakeJwt({ sub: 'google-account-subject-123', email: 'operator@example.com' }),
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  })}\n`, 'utf8');

  try {
    const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
    const parsed = readGeminiCliCredentials({
      credentialsFile,
      projectId: 'gemini-cli-smoke-project',
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.token.access_token, 'gemini-cli-access-token-secret');
    assert.equal(parsed.token.refresh_token, 'gemini-cli-refresh-token-secret');
    assert.equal(parsed.token.id_token, undefined, 'id_token must not be persisted into Hub token payload');
    assert.equal(parsed.metadata.account_email_domain, 'example.com');
    assert.equal(JSON.stringify(parsed.metadata).includes('operator@example.com'), false);
    assert.equal(parsed.metadata.identity_present, true);

    const result = spawnSync(
      tsxBin,
      [
        path.join(repoRoot, 'bots/hub/scripts/gemini-cli-oauth-import.ts'),
        '--credentials-file',
        credentialsFile,
        '--project-id',
        'gemini-cli-smoke-project',
      ],
      {
        cwd: path.join(repoRoot, 'bots/hub'),
        env: {
          ...process.env,
          HUB_OAUTH_STORE_FILE: tokenStoreFile,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.includes('gemini-cli-access-token-secret'), false);
    assert.equal(result.stdout.includes('gemini-cli-refresh-token-secret'), false);

    const store = JSON.parse(fs.readFileSync(tokenStoreFile, 'utf8'));
    const record = store.providers['gemini-cli-oauth'];
    assert.equal(record.token.access_token, 'gemini-cli-access-token-secret');
    assert.equal(record.token.id_token, undefined);
    assert.equal(record.metadata.source, 'gemini_cli_oauth_creds');
    assert.equal(record.metadata.cli_provider, 'google-gemini-cli');
    assert.equal(record.metadata.quota_project_id, 'gemini-cli-smoke-project');
    assert.equal(record.metadata.identity_present, true);
    assert.equal(JSON.stringify(record.metadata).includes('operator@example.com'), false);

    console.log(JSON.stringify({
      ok: true,
      provider: 'gemini-cli-oauth',
      source: 'gemini_cli_oauth_creds',
      token_redaction_checked: true,
      identity_binding_checked: true,
    }));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[gemini-cli-oauth-import-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
