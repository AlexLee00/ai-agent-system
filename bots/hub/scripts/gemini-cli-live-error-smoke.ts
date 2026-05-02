#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'assert';
const { classifyGeminiCliLiveError } = require('../lib/oauth/gemini-cli-live-error.ts');

const serviceDisabled = classifyGeminiCliLiveError(`
  Gemini CLI probe failed with 403.
  reason: SERVICE_DISABLED
  service: cloudaicompanion.googleapis.com
  Gemini for Google Cloud API has not been used in project gen-lang-client-0627707293 before or it is disabled.
  Enable it by visiting https://console.developers.google.com/apis/api/cloudaicompanion.googleapis.com/overview?project=gen-lang-client-0627707293
`);

assert.equal(serviceDisabled.kind, 'service_disabled');
assert.equal(serviceDisabled.service, 'cloudaicompanion.googleapis.com');
assert(
  String(serviceDisabled.activationUrl || '').includes('cloudaicompanion.googleapis.com/overview?project=gen-lang-client-0627707293'),
  'service disabled classification must preserve activation URL',
);
assert(
  String(serviceDisabled.operatorAction || '').includes('Enable Gemini for Google Cloud API'),
  'service disabled classification must provide operator action',
);

const quotaProject = classifyGeminiCliLiveError('Gemini CLI OAuth needs a quota project before live probing.');
assert.equal(quotaProject.kind, 'quota_project_missing');
assert.equal(quotaProject.activationUrl, null);

const authRequired = classifyGeminiCliLiveError('invalid_grant: token expired; run login again');
assert.equal(authRequired.kind, 'auth_required');

const unknown = classifyGeminiCliLiveError('model returned a transient empty response');
assert.equal(unknown.kind, 'unknown');
assert.equal(unknown.operatorAction, null);

console.log(JSON.stringify({ ok: true, checked: 4 }, null, 2));
