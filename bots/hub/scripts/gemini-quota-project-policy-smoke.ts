#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');

const {
  geminiCliQuotaProjectRequired,
  geminiQuotaProjectStatus,
  resolveGeminiQuotaProject,
} = require('../lib/oauth/gemini-quota-project.ts');

const originalEnv = {
  GEMINI_OAUTH_PROJECT_ID: process.env.GEMINI_OAUTH_PROJECT_ID,
  GOOGLE_CLOUD_QUOTA_PROJECT: process.env.GOOGLE_CLOUD_QUOTA_PROJECT,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  HUB_GEMINI_CLI_REQUIRE_PROJECT: process.env.HUB_GEMINI_CLI_REQUIRE_PROJECT,
  HUB_GEMINI_CLI_REQUIRE_QUOTA_PROJECT: process.env.HUB_GEMINI_CLI_REQUIRE_QUOTA_PROJECT,
  HUB_OAUTH_OPS_REQUIRE_GEMINI_QUOTA_PROJECT: process.env.HUB_OAUTH_OPS_REQUIRE_GEMINI_QUOTA_PROJECT,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearProjectEnv() {
  delete process.env.GEMINI_OAUTH_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_QUOTA_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.HUB_GEMINI_CLI_REQUIRE_PROJECT;
  delete process.env.HUB_GEMINI_CLI_REQUIRE_QUOTA_PROJECT;
  delete process.env.HUB_OAUTH_OPS_REQUIRE_GEMINI_QUOTA_PROJECT;
}

try {
  clearProjectEnv();

  assert.equal(resolveGeminiQuotaProject(), '');
  assert.equal(geminiCliQuotaProjectRequired(), false);

  const cliDefault = geminiQuotaProjectStatus({
    provider: 'gemini-cli-oauth',
    configured: false,
    requiredByTeam: true,
    requireProject: geminiCliQuotaProjectRequired(),
  });
  assert.equal(cliDefault.status, 'optional_missing');
  assert.equal(cliDefault.required, false);

  const directRequired = geminiQuotaProjectStatus({
    provider: 'gemini-oauth',
    configured: false,
    requiredByTeam: true,
  });
  assert.equal(directRequired.status, 'required_missing');
  assert.equal(directRequired.required, true);

  process.env.HUB_GEMINI_CLI_REQUIRE_QUOTA_PROJECT = '1';
  const cliStrict = geminiQuotaProjectStatus({
    provider: 'gemini-cli-oauth',
    configured: false,
    requiredByTeam: true,
    requireProject: geminiCliQuotaProjectRequired(),
  });
  assert.equal(cliStrict.status, 'required_missing');
  assert.equal(cliStrict.required, true);

  process.env.GEMINI_OAUTH_PROJECT_ID = 'gemini-quota-policy-smoke';
  const configured = geminiQuotaProjectStatus({
    provider: 'gemini-cli-oauth',
    configured: Boolean(resolveGeminiQuotaProject()),
    requiredByTeam: true,
    requireProject: geminiCliQuotaProjectRequired(),
  });
  assert.equal(configured.status, 'configured');
  assert.equal(configured.configured, true);

  console.log(JSON.stringify({
    ok: true,
    cli_default_missing_is_optional: true,
    cli_strict_missing_is_required: true,
    direct_missing_is_required: true,
    configured_project_is_configured: true,
  }));
} finally {
  restoreEnv();
}
