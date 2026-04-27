#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');

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

async function main() {
  const args = parseArgs(process.argv);
  const command = checkCommand(geminiCommand());
  const credentials = readGeminiCliCredentials({
    credentialsFile: args.credentialsFile,
    projectId: args.projectId,
  });
  const expiresInHours = credentials.ok ? tokenExpiresInHours(credentials.token) : null;
  const credentialFile = String(credentials.filePath || '').trim();
  const credentialSummary = {
    ok: Boolean(credentials.ok),
    source: credentials.source || null,
    credentials_file_configured: Boolean(credentialFile),
    credentials_file_exists: Boolean(credentialFile && fs.existsSync(credentialFile)),
    credentials_file_basename: credentialFile ? path.basename(credentialFile) : null,
    expires_at: credentials.token?.expires_at || null,
    expires_in_hours: Number.isFinite(Number(expiresInHours)) ? Math.round(Number(expiresInHours) * 100) / 100 : null,
    quota_project_configured: Boolean(credentials.quota_project_configured),
    identity_present: Boolean(credentials.metadata?.identity_present),
    account_email_domain: credentials.metadata?.account_email_domain || null,
    error: credentials.ok ? null : credentials.error || 'gemini_cli_credentials_unavailable',
  };

  let live = null;
  const liveRequested = Boolean(args.live || flag('HUB_GEMINI_CLI_READINESS_LIVE'));
  const requireProject = Boolean(args.requireProject || flag('HUB_GEMINI_CLI_REQUIRE_PROJECT'));
  if (liveRequested) {
    const result = await runLiveProbe();
    live = {
      ok: Boolean(result.ok),
      provider: result.provider || null,
      selected_route: result.selected_route || null,
      duration_ms: Number(result.durationMs || 0),
      error: result.error || null,
      response_preview: String(result.result || result.text || '').slice(0, 80),
    };
  }

  const ok = Boolean(
    command.ok
      && credentials.ok
      && (!requireProject || credentialSummary.quota_project_configured)
      && (!liveRequested || live?.ok),
  );
  const report = {
    ok,
    provider: 'gemini-cli-oauth',
    generated_at: new Date().toISOString(),
    command,
    credentials: credentialSummary,
    require_project: requireProject,
    live_requested: liveRequested,
    live,
    warnings: [
      ...(credentials.ok && !credentialSummary.quota_project_configured ? [
        'quota project is missing; Gemini CLI OAuth can still run, but direct Gemini OAuth API canaries/imports may fail until GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT is set',
      ] : []),
    ],
    next_actions: ok ? [] : [
      ...(!command.ok ? ['Install Gemini CLI: npm install -g @google/gemini-cli or brew install gemini-cli'] : []),
      ...(!credentials.ok ? ['Run Gemini CLI login so ~/.gemini/oauth_creds.json exists'] : []),
      ...(requireProject && credentials.ok && !credentialSummary.quota_project_configured ? ['Set GEMINI_OAUTH_PROJECT_ID or GOOGLE_CLOUD_PROJECT'] : []),
      ...(liveRequested && live && !live.ok ? ['Check Gemini CLI auth/session by running a tiny gemini CLI prompt manually'] : []),
    ],
  };

  if (args.json || flag('HUB_GEMINI_CLI_READINESS_JSON')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`gemini-cli-oauth readiness: ${ok ? 'ok' : 'not-ready'}`);
    console.log(`command: ${command.ok ? 'ok' : command.error}`);
    console.log(`credentials: ${credentialSummary.ok ? 'ok' : credentialSummary.error}`);
    console.log(`quota project: ${credentialSummary.quota_project_configured ? 'configured' : requireProject ? 'missing (required)' : 'missing (direct API only)'}`);
    if (liveRequested) console.log(`live: ${live?.ok ? 'ok' : live?.error || 'failed'}`);
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[gemini-cli-oauth-readiness] failed:', error?.message || error);
  process.exitCode = 1;
});
