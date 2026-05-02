#!/usr/bin/env tsx
// @ts-nocheck

import { checkTokenHealth, checkOpenAIOAuthHealth, checkGroqAccounts } from '../lib/llm/oauth-monitor';

const { PROFILES } = require('../lib/runtime-profiles.ts');
const { getGeminiOauthStatus } = require('../lib/oauth/providers/gemini-oauth.ts');
const { getProviderRecord } = require('../lib/oauth/token-store.ts');
const { readGeminiCliCredentials } = require('../lib/oauth/gemini-cli-credentials.ts');
const {
  geminiCliQuotaProjectRequired,
  geminiQuotaProjectStatus,
} = require('../lib/oauth/gemini-quota-project.ts');

const UNSUITABLE_AGENT_RE = /(image|gemma|stt|whisper|local)/i;

function routeToProvider(route: string) {
  const normalized = String(route || '').trim();
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalized.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalized.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (normalized.startsWith('gemini-oauth/')) return 'gemini-oauth';
  if (normalized.startsWith('groq/')) return 'groq';
  if (normalized.startsWith('openai/')) return 'openai';
  if (normalized.startsWith('google-gemini-cli/') || normalized.startsWith('gemini/')) return 'gemini';
  if (normalized.startsWith('local/')) return 'local';
  return '';
}

function tokenExpiresInHours(token: any): number | null {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  return (expiresMs - Date.now()) / (60 * 60 * 1000);
}

function refreshWarnHours(): number {
  const value = Number(process.env.HUB_OAUTH_REFRESH_WARN_HOURS || 24);
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function allRoutes(profile: any) {
  return [
    ...(profile?.primary_routes || []),
    ...(profile?.fallback_routes || []),
  ].filter(Boolean);
}

function firstSupportedRoute(profile: any) {
  return allRoutes(profile).find((route) => routeToProvider(route));
}

function firstOauthRoute(profile: any) {
  return allRoutes(profile).find((route) => {
    const provider = routeToProvider(route);
    return provider === 'openai-oauth'
      || provider === 'claude-code-oauth'
      || provider === 'gemini-cli-oauth'
      || provider === 'gemini-oauth';
  });
}

function isOauthProvider(provider: string) {
  return provider === 'openai-oauth'
    || provider === 'claude-code-oauth'
    || provider === 'gemini-cli-oauth'
    || provider === 'gemini-oauth';
}

function summarizeTeamCoverage() {
  return Object.entries(PROFILES || {})
    .map(([team, profiles]) => {
      const entries = Object.entries(profiles || {})
        .filter(([agent, profile]) => !UNSUITABLE_AGENT_RE.test(agent) && firstSupportedRoute(profile));
      const oauthFirst = entries.find(([, profile]) => {
        const provider = routeToProvider(firstSupportedRoute(profile));
        return isOauthProvider(provider);
      });
      const defaultEntry = entries.find(([agent]) => agent === 'default');
      const selected = oauthFirst || defaultEntry || entries[0];
      const [agent, profile] = selected || ['default', {}];
      const selectedRoute = firstSupportedRoute(profile);
      const oauthRoute = firstOauthRoute(profile);
      return {
        team,
        selected_agent: agent,
        selected_provider: routeToProvider(selectedRoute),
        selected_route_family: routeFamily(selectedRoute),
        oauth_route_available: Boolean(oauthRoute),
        oauth_route_family: oauthRoute ? routeFamily(oauthRoute) : null,
      };
    })
    .sort((a, b) => a.team.localeCompare(b.team));
}

function routeFamily(route: string) {
  const text = String(route || '');
  if (!text) return null;
  const [provider, model] = text.split('/');
  return model ? `${provider}/${model}` : provider;
}

function anyProfileRouteUses(providerName: string) {
  return Object.values(PROFILES || {}).some((profiles: any) => Object.values(profiles || {}).some((profile: any) => {
    return allRoutes(profile).some((route) => routeToProvider(route) === providerName);
  }));
}

async function main() {
  const [claude, openai, gemini, groq] = await Promise.all([
    checkTokenHealth(),
    checkOpenAIOAuthHealth(),
    getGeminiOauthStatus(),
    checkGroqAccounts(),
  ]);
  const warnHours = refreshWarnHours();
  const openaiExpiresInHours = tokenExpiresInHours(getProviderRecord('openai-codex-oauth')?.token || null);
  const geminiRecord = getProviderRecord('gemini-oauth');
  const geminiCliRecord = getProviderRecord('gemini-cli-oauth');
  const geminiCliLocal = readGeminiCliCredentials({
    credentialsFile: geminiCliRecord?.metadata?.credential_path || process.env.GEMINI_CLI_OAUTH_CREDS_FILE,
  });
  const geminiExpiresInHours = tokenExpiresInHours(geminiRecord?.token || null);
  const geminiCliExpiresInHours = tokenExpiresInHours(geminiCliRecord?.token || geminiCliLocal?.token || null);
  const teamCoverage = summarizeTeamCoverage();
  const teamsWithoutOauthRoute = teamCoverage.filter((item) => !item.oauth_route_available);
  const geminiRequired = teamCoverage.some((item) => item.selected_provider === 'gemini-oauth' || item.oauth_route_family?.startsWith('gemini-oauth/'));
  const geminiCliRequired = teamCoverage.some((item) => item.selected_provider === 'gemini-cli-oauth' || item.oauth_route_family?.startsWith('gemini-cli-oauth/'))
    || anyProfileRouteUses('gemini-cli-oauth');
  const geminiReady = Boolean(gemini?.has_token && !gemini?.expired && gemini?.quota_project_configured);
  const geminiQuotaConfigured = Boolean(gemini?.quota_project_configured);
  const geminiQuotaPolicy = geminiQuotaProjectStatus({
    provider: 'gemini-oauth',
    configured: geminiQuotaConfigured,
    requiredByTeam: geminiRequired,
  });
  const geminiCliReady = Boolean(
    geminiCliRecord?.token?.refresh_token
      || geminiCliLocal?.token?.refresh_token,
  );
  const geminiCliQuotaConfigured = Boolean(
    geminiCliRecord?.metadata?.quota_project_configured
      || geminiCliLocal?.quota_project_configured,
  );
  const geminiCliQuotaPolicy = geminiQuotaProjectStatus({
    provider: 'gemini-cli-oauth',
    configured: geminiCliQuotaConfigured,
    requiredByTeam: geminiCliRequired,
    requireProject: geminiCliQuotaProjectRequired(),
  });
  const ok = Boolean(
    claude.healthy
      && openai.healthy
      && (!geminiRequired || geminiReady)
      && (!geminiCliRequired || geminiCliReady)
      && (!geminiCliQuotaPolicy.required || geminiCliQuotaPolicy.configured)
      && teamsWithoutOauthRoute.length === 0,
  );

  console.log(JSON.stringify({
    ok,
    generated_at: new Date().toISOString(),
    providers: {
      claude_code_oauth: {
        healthy: Boolean(claude.healthy),
        needs_refresh: Boolean(claude.needs_refresh),
        expires_in_hours: Number.isFinite(Number(claude.expires_in_hours))
          ? Math.round(Number(claude.expires_in_hours) * 10) / 10
          : null,
        auth_method_present: Boolean(claude.auth_method),
        account_present: Boolean(claude.account),
        error: claude.error || null,
      },
      openai_oauth: {
        healthy: Boolean(openai.healthy),
        token_present: Boolean(openai.token_present),
        source: openai.source || null,
        model: openai.model || null,
        expires_in_hours: Number.isFinite(Number(openaiExpiresInHours))
          ? Math.round(Number(openaiExpiresInHours) * 10) / 10
          : null,
        needs_refresh: Number.isFinite(Number(openaiExpiresInHours))
          ? Number(openaiExpiresInHours) <= warnHours
          : false,
        error: openai.error || null,
      },
      gemini_oauth: {
        enabled: Boolean(gemini?.enabled),
        required_by_team: geminiRequired,
        healthy: geminiRequired ? geminiReady : Boolean(gemini?.has_token && !gemini?.expired && gemini?.quota_project_configured),
        token_present: Boolean(gemini?.has_token),
        expired: Boolean(gemini?.expired),
        quota_project_configured: geminiQuotaConfigured,
        quota_project_required: geminiQuotaPolicy.required,
        quota_project_status: geminiQuotaPolicy.status,
        quota_project_reason: geminiQuotaPolicy.reason,
        expires_in_hours: Number.isFinite(Number(geminiExpiresInHours))
          ? Math.round(Number(geminiExpiresInHours) * 100) / 100
          : null,
        needs_refresh: Number.isFinite(Number(geminiExpiresInHours))
          ? Number(geminiExpiresInHours) <= warnHours
          : Boolean(gemini?.expired),
      },
      gemini_cli_oauth: {
        required_by_team: geminiCliRequired,
        healthy: geminiCliRequired ? geminiCliReady : geminiCliReady,
        token_store_present: Boolean(geminiCliRecord?.token?.refresh_token),
        local_cli_credentials_present: Boolean(geminiCliLocal?.token?.refresh_token),
        quota_project_configured: geminiCliQuotaConfigured,
        quota_project_required: geminiCliQuotaPolicy.required,
        quota_project_status: geminiCliQuotaPolicy.status,
        quota_project_reason: geminiCliQuotaPolicy.reason,
        expires_in_hours: Number.isFinite(Number(geminiCliExpiresInHours))
          ? Math.round(Number(geminiCliExpiresInHours) * 100) / 100
          : null,
        needs_cli_refresh: Number.isFinite(Number(geminiCliExpiresInHours))
          ? Number(geminiCliExpiresInHours) <= warnHours
          : false,
        error: geminiCliLocal?.ok === false ? geminiCliLocal.error || null : null,
      },
      groq_pool: {
        available_accounts: Number(groq.available_accounts || 0),
        total_accounts: Number(groq.total_accounts || 0),
      },
    },
    team_coverage: {
      total_teams: teamCoverage.length,
      oauth_route_available: teamCoverage.length - teamsWithoutOauthRoute.length,
      teams_without_oauth_route: teamsWithoutOauthRoute.map((item) => item.team),
      teams: teamCoverage,
    },
    notes: [
      'This report intentionally redacts provider tokens, account identifiers, and raw secrets.',
      'Use team:llm-drill:live for actual per-team LLM call verification.',
    ],
  }, null, 2));

  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[team-oauth-readiness-report] failed:', error?.message || error);
  process.exitCode = 1;
});
