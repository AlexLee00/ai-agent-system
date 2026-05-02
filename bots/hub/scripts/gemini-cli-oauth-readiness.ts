#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
const { classifyGeminiCliLiveError } = require('../lib/oauth/gemini-cli-live-error.ts');
const {
  geminiCliQuotaProjectRequired,
  geminiQuotaProjectStatus,
} = require('../lib/oauth/gemini-quota-project.ts');

function flag(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function parseArgs(argv: string[]) {
  const out: any = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--credentials-file') out.credentialsFile = argv[++index];
    else if (arg === '--project-id') out.projectId = argv[++index];
    else if (arg === '--json') out.json = true;
    else if (arg === '--live') out.live = true;
    else if (arg === '--require-project') out.requireProject = true;
  }
  return out;
}

function geminiCommand(): string {
  return String(process.env.GEMINI_CLI_COMMAND || 'gemini').trim() || 'gemini';
}

function commandLooksLikePath(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function checkCommand(command: string) {
  if (commandLooksLikePath(command)) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
    } catch {
      return { ok: false, command, error: 'gemini_cli_command_not_executable' };
    }
  }

  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  if (result.error?.code === 'ENOENT') {
    return { ok: false, command, error: 'gemini_cli_not_found' };
  }
  if (result.error) {
    return { ok: false, command, error: String(result.error.message || result.error).slice(0, 240) };
  }
  return {
    ok: result.status === 0,
    command,
    status: result.status,
    version_preview: String(result.stdout || result.stderr || '').trim().split('\n')[0]?.slice(0, 120) || null,
    ...(result.status === 0 ? {} : { error: 'gemini_cli_version_failed' }),
  };
}

function tokenExpiresInHours(token: any): number | null {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  return (expiresMs - Date.now()) / (60 * 60 * 1000);
}

function refreshWarnHours(): number {
  const value = Number(process.env.HUB_GEMINI_CLI_OAUTH_WARN_HOURS || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

async function runLiveProbe() {
  const { callWithFallback } = await import('../lib/llm/unified-caller.ts');
  return callWithFallback({
    callerTeam: 'orchestrator',
    agent: 'steward',
    selectorKey: 'hub.gemini.cli.readiness.live',
    chain: [{
      provider: 'gemini-cli-oauth',
      model: process.env.GEMINI_CLI_READINESS_MODEL || 'gemini-cli-oauth/gemini-2.5-flash',
      maxTokens: 32,
      temperature: 0,
      timeoutMs: Number(process.env.GEMINI_CLI_READINESS_TIMEOUT_MS || 30_000),
    }],
    systemPrompt: 'You are a readiness probe. Do not reveal secrets.',
    prompt: 'Reply exactly: gemini cli ok',
    timeoutMs: Number(process.env.GEMINI_CLI_READINESS_TIMEOUT_MS || 30_000),
    cacheEnabled: false,
  });
}

function runLiveFailureDiagnostic(command: string) {
  const model = String(process.env.GEMINI_CLI_READINESS_MODEL || 'gemini-cli-oauth/gemini-2.5-flash')
    .replace(/^gemini-cli-oauth\//, '')
    .replace(/^google-gemini-cli\//, '')
    .replace(/^gemini\//, '');
  const result = spawnSync(command, [
    '--skip-trust',
    '--output-format',
    'json',
    '--model',
    model || 'gemini-2.5-flash',
    '--prompt',
    'Reply exactly: gemini cli ok',
  ], {
    encoding: 'utf8',
    timeout: Number(process.env.GEMINI_CLI_READINESS_TIMEOUT_MS || 30_000),
    maxBuffer: 4 * 1024 * 1024,
  });
  const combined = [
    result.error?.message,
    result.stderr,
    result.stdout,
  ].filter(Boolean).join('\n');
  return {
    status: result.status,
    signal: result.signal || null,
    classification: classifyGeminiCliLiveError(combined),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const command = checkCommand(geminiCommand());
  const credentials = readGeminiCliCredentials({
    credentialsFile: args.credentialsFile,
    projectId: args.projectId,
  });
  const expiresInHours = credentials.ok ? tokenExpiresInHours(credentials.token) : null;
  const expired = Number.isFinite(Number(expiresInHours)) ? Number(expiresInHours) <= 0 : false;
  const needsRefresh = Number.isFinite(Number(expiresInHours))
    ? Number(expiresInHours) <= refreshWarnHours()
    : false;
  const credentialFile = String(credentials.filePath || '').trim();
  const credentialSummary = {
    ok: Boolean(credentials.ok),
    source: credentials.source || null,
    credentials_file_configured: Boolean(credentialFile),
    credentials_file_exists: Boolean(credentialFile && fs.existsSync(credentialFile)),
    credentials_file_basename: credentialFile ? path.basename(credentialFile) : null,
    expires_at: credentials.token?.expires_at || null,
    expires_in_hours: Number.isFinite(Number(expiresInHours)) ? Math.round(Number(expiresInHours) * 100) / 100 : null,
    expired,
    needs_refresh: needsRefresh,
    quota_project_configured: Boolean(credentials.quota_project_configured),
    identity_present: Boolean(credentials.metadata?.identity_present),
    account_email_domain: credentials.metadata?.account_email_domain || null,
    error: credentials.ok ? null : credentials.error || 'gemini_cli_credentials_unavailable',
  };

  let live = null;
  const liveRequested = Boolean(args.live || flag('HUB_GEMINI_CLI_READINESS_LIVE'));
  const requireProject = Boolean(args.requireProject || geminiCliQuotaProjectRequired());
  const quotaPolicy = geminiQuotaProjectStatus({
    provider: 'gemini-cli-oauth',
    configured: credentialSummary.quota_project_configured,
    requiredByTeam: true,
    requireProject,
  });
  if (liveRequested) {
    const result = await runLiveProbe();
    const liveError = result.error || null;
    let liveErrorClassification = liveError ? classifyGeminiCliLiveError(liveError) : null;
    let diagnostic = null;
    if (liveErrorClassification?.kind === 'unknown') {
      diagnostic = runLiveFailureDiagnostic(geminiCommand());
      if (diagnostic.classification?.kind && diagnostic.classification.kind !== 'unknown') {
        liveErrorClassification = diagnostic.classification;
      }
    }
    live = {
      ok: Boolean(result.ok),
      provider: result.provider || null,
      selected_route: result.selected_route || null,
      duration_ms: Number(result.durationMs || 0),
      error: liveError,
      error_kind: liveErrorClassification?.kind || null,
      service: liveErrorClassification?.service || null,
      activation_url: liveErrorClassification?.activationUrl || null,
      operator_action: liveErrorClassification?.operatorAction || null,
      diagnostic_checked: Boolean(diagnostic),
      diagnostic_status: diagnostic?.status ?? null,
      diagnostic_signal: diagnostic?.signal || null,
      response_preview: String(result.result || result.text || '').slice(0, 80),
    };
  }

  const ok = Boolean(
    command.ok
      && credentials.ok
      && (!quotaPolicy.required || quotaPolicy.configured)
      && (!liveRequested || live?.ok),
  );
  const report = {
    ok,
    provider: 'gemini-cli-oauth',
    generated_at: new Date().toISOString(),
    command,
    credentials: credentialSummary,
    require_project: requireProject,
    quota_project_policy: quotaPolicy,
    live_requested: liveRequested,
    live,
    warnings: [
      ...(credentials.ok && quotaPolicy.status === 'optional_missing' ? [
        'quota project is optional for Gemini CLI OAuth default mode; set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT for direct Gemini API/pro quota attribution',
      ] : []),
      ...(credentials.ok && quotaPolicy.status === 'required_missing' ? [
        'quota project is required because strict Gemini CLI readiness is enabled; set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT',
      ] : []),
      ...(credentials.ok && needsRefresh && live?.ok ? [
        'local Gemini CLI OAuth access token is expired/near expiry, but live CLI probe succeeded via refresh-token path',
      ] : []),
      ...(credentials.ok && needsRefresh && !liveRequested ? [
        'local Gemini CLI OAuth access token is expired/near expiry; run with --live to verify CLI refresh before reauth',
      ] : []),
    ],
    next_actions: ok ? [] : [
      ...(!command.ok ? ['Install Gemini CLI: npm install -g @google/gemini-cli or brew install gemini-cli'] : []),
      ...(!credentials.ok ? ['Run Gemini CLI login so ~/.gemini/oauth_creds.json exists'] : []),
      ...(quotaPolicy.status === 'required_missing' ? ['Set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT'] : []),
      ...(live?.activation_url ? [`Enable required Google API: ${live.activation_url}`] : []),
      ...(live?.operator_action ? [live.operator_action] : []),
      ...(liveRequested && live && !live.ok ? ['Check Gemini CLI auth/session by running a tiny gemini CLI prompt manually'] : []),
    ],
  };

  if (args.json || flag('HUB_GEMINI_CLI_READINESS_JSON')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`gemini-cli-oauth readiness: ${ok ? 'ok' : 'not-ready'}`);
    console.log(`command: ${command.ok ? 'ok' : command.error}`);
    console.log(`credentials: ${credentialSummary.ok ? 'ok' : credentialSummary.error}`);
    console.log(`quota project: ${quotaPolicy.status}`);
    if (liveRequested) console.log(`live: ${live?.ok ? 'ok' : live?.error || 'failed'}`);
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[gemini-cli-oauth-readiness] failed:', error?.message || error);
  process.exitCode = 1;
});
