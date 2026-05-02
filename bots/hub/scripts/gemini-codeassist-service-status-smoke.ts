#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const {
  buildServiceUsageUrl,
  checkGeminiCodeAssistServiceStatus,
  serviceActivationUrl,
  summarizeServiceUsageError,
} = require('../lib/oauth/gemini-codeassist-service-status.ts');

async function main() {
  assert.equal(
    buildServiceUsageUrl('gen-lang-client-0627707293'),
    'https://serviceusage.googleapis.com/v1/projects/gen-lang-client-0627707293/services/cloudaicompanion.googleapis.com',
  );
  assert.equal(
    serviceActivationUrl('gen-lang-client-0627707293'),
    'https://console.developers.google.com/apis/api/cloudaicompanion.googleapis.com/overview?project=gen-lang-client-0627707293',
  );

  const enabled = await checkGeminiCodeAssistServiceStatus({
    projectId: 'p1',
    accessToken: 'token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: 'ENABLED' }),
    }),
  });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state, 'ENABLED');

  const disabled = await checkGeminiCodeAssistServiceStatus({
    projectId: 'p1',
    accessToken: 'token',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: 'DISABLED' }),
    }),
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.kind, 'service_disabled');
  assert.match(disabled.operator_action, /Enable Gemini for Google Cloud API/);

  const denied = summarizeServiceUsageError(403, {
    error: {
      status: 'PERMISSION_DENIED',
      message: 'Permission denied',
    },
  });
  assert.equal(denied.kind, 'forbidden');
  assert.equal(denied.google_status, 'PERMISSION_DENIED');

  const missing = await checkGeminiCodeAssistServiceStatus({ projectId: '', accessToken: 'token' });
  assert.equal(missing.error, 'gemini_codeassist_project_missing');

  console.log(JSON.stringify({ ok: true, checked: 5 }));
}

main().catch((error) => {
  console.error('[gemini-codeassist-service-status-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
