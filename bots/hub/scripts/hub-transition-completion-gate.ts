#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { PROFILES } = require('../lib/runtime-profiles.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HUB_ROOT = path.resolve(__dirname, '..');

const REQUIRED_ROUTES = [
  '/hub/health',
  '/hub/health/ready',
  '/hub/llm/call',
  '/hub/alarm',
  '/hub/alarm/digest/flush',
  '/hub/oauth/:provider/status',
  '/hub/oauth/:provider/import-local',
  '/hub/control/plan',
  '/hub/control/execute',
  '/hub/control/callback',
  '/hub/tools/:name/call',
  '/hub/pg/query',
  '/hub/metrics',
  '/hub/metrics/json',
];

const REQUIRED_PACKAGE_SCRIPTS = [
  'test:unit',
  'check:runtime',
  'check:l5',
  'check:l5:live-llm',
  'team:llm-drill',
  'oauth:team-readiness',
  'telegram:routing-readiness',
  'agent:hub-transition-audit',
  'transition:completion-gate',
];

const RETIRED_GATEWAY_MARKERS = [
  'legacy_gateway',
  'retiredGatewaySecrets',
  "open${'claw'}",
  'openclaw',
  'openclaw-gateway',
  'OPENCLAW_BIN',
  '18789',
];

const RETIRED_GATEWAY_SOURCE_PATTERN = 'openclaw|legacy_gateway|18789|openclaw-gateway|OPENCLAW_BIN|execFile\\([^\\n]*openclaw|spawn\\([^\\n]*openclaw';

const RUNTIME_SOURCE_SCOPES = [
  'packages/core/lib',
  'bots/orchestrator/src',
  'bots/claude/lib',
  'bots/claude/src',
  'bots/blog/lib',
  'bots/blog/scripts',
  'bots/investment/shared',
  'bots/investment/team',
  'bots/investment/markets',
  'bots/reservation/src',
  'bots/reservation/lib',
  'bots/ska',
  'bots/sigma/shared',
  'bots/worker/lib',
  'bots/legal/lib',
  'bots/darwin/lib',
];

function repoPath(relativePath: string): string {
  return path.join(REPO_ROOT, relativePath);
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function assertIncludesAll(label: string, source: string, needles: string[]): void {
  const missing = needles.filter((needle) => !source.includes(needle));
  assert.deepEqual(missing, [], `${label} missing required entries: ${missing.join(', ')}`);
}

function assertNotIncludesAny(label: string, source: string, needles: string[]): void {
  const found = needles.filter((needle) => source.includes(needle));
  assert.deepEqual(found, [], `${label} must not contain retired gateway surface: ${found.join(', ')}`);
}

function routeToProvider(route: string): string {
  const normalized = String(route || '').trim();
  if (normalized.startsWith('claude-code/')) return 'claude-code-oauth';
  if (normalized.startsWith('openai-oauth/')) return 'openai-oauth';
  if (normalized.startsWith('gemini-oauth/')) return 'gemini-oauth';
  if (normalized.startsWith('groq/')) return 'groq';
  if (normalized.startsWith('openai/')) return 'openai';
  if (normalized.startsWith('google-gemini-cli/') || normalized.startsWith('gemini/')) return 'gemini';
  if (normalized.startsWith('local/')) return 'local';
  return '';
}

function profileRoutes(profile: Record<string, any>): string[] {
  return [
    ...(Array.isArray(profile.primary_routes) ? profile.primary_routes : []),
    ...(Array.isArray(profile.fallback_routes) ? profile.fallback_routes : []),
  ].map((route) => String(route));
}

function profileHasLlmRoute(profile: Record<string, any>): boolean {
  const routes = profileRoutes(profile);
  if (routes.some((route) => Boolean(routeToProvider(route)))) return true;
  if (profile.provider && profile.model) return true;
  if (profile.direct_provider && profile.direct_model) return true;
  return false;
}

function isLocalOnlyProfile(profile: Record<string, any>): boolean {
  return Boolean(profile.local_image || profile.engine || profile.checkpoint_name || profile.workflow_template_path);
}

function validateRouteRegistry(): void {
  const source = readRepoFile('bots/hub/src/route-registry.ts');
  assertIncludesAll('Hub route registry', source, REQUIRED_ROUTES);
}

function validatePackageScripts(): void {
  const pkg = JSON.parse(readRepoFile('bots/hub/package.json'));
  const missing = REQUIRED_PACKAGE_SCRIPTS.filter((script) => typeof pkg.scripts?.[script] !== 'string');
  assert.deepEqual(missing, [], `bots/hub/package.json missing scripts: ${missing.join(', ')}`);
}

function validateSecretsRoute(): void {
  const source = readRepoFile('bots/hub/lib/routes/secrets.ts');
  assertNotIncludesAny('Hub secrets route', source, RETIRED_GATEWAY_MARKERS);
}

function validateRuntimeProfiles(): { profiles: number; teams: number } {
  const claudeSettingsRoot = path.join(REPO_ROOT, 'bots/hub/config/claude-code');
  const findings: Array<Record<string, string>> = [];
  let profileCount = 0;

  for (const [team, profiles] of Object.entries(PROFILES || {})) {
    for (const [purpose, rawProfile] of Object.entries((profiles || {}) as Record<string, Record<string, any>>)) {
      const profile = rawProfile || {};
      profileCount += 1;
      const label = `${team}.${purpose}`;
      const serialized = JSON.stringify(profile);
      if (new RegExp(RETIRED_GATEWAY_SOURCE_PATTERN, 'i').test(serialized)) {
        findings.push({ label, code: 'retired_gateway_marker' });
      }

      const routes = profileRoutes(profile);
      const unsupportedRoutes = routes.filter((route) => !routeToProvider(route));
      if (unsupportedRoutes.length > 0) {
        findings.push({ label, code: 'unsupported_route_prefix', value: unsupportedRoutes.join(',') });
      }

      if (!isLocalOnlyProfile(profile) && !profileHasLlmRoute(profile)) {
        findings.push({ label, code: 'missing_hub_llm_route' });
      }

      if (profile.claude_code_settings) {
        const settingsPath = path.resolve(String(profile.claude_code_settings));
        if (!settingsPath.startsWith(`${claudeSettingsRoot}${path.sep}`)) {
          findings.push({ label, code: 'claude_settings_not_hub_owned', value: settingsPath });
        }
        if (!fs.existsSync(settingsPath)) {
          findings.push({ label, code: 'claude_settings_missing', value: settingsPath });
        }
      }
    }
  }

  assert.deepEqual(findings, [], `runtime profile transition findings:\n${JSON.stringify(findings, null, 2)}`);
  return { profiles: profileCount, teams: Object.keys(PROFILES || {}).length };
}

function validateRuntimeSourceScan(): { scannedScopes: number } {
  const scopes = RUNTIME_SOURCE_SCOPES.filter((scope) => fs.existsSync(repoPath(scope)));
  const result = spawnSync('rg', [
    '-n',
    '-S',
    RETIRED_GATEWAY_SOURCE_PATTERN,
    ...scopes,
    '--glob',
    '!**/*.log',
    '--glob',
    '!**/*.md',
    '--glob',
    '!**/output/**',
    '--glob',
    '!**/data/**',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  if (![0, 1].includes(Number(result.status))) {
    throw new Error(`runtime source scan failed: ${result.stderr || result.stdout || `status ${result.status}`}`);
  }
  assert.equal((result.stdout || '').trim(), '', `runtime source contains retired gateway references:\n${result.stdout}`);
  return { scannedScopes: scopes.length };
}

function main(): void {
  assert.equal(fs.existsSync(HUB_ROOT), true, 'Hub root must exist');
  validateRouteRegistry();
  validatePackageScripts();
  validateSecretsRoute();
  const runtimeProfileSummary = validateRuntimeProfiles();
  const sourceScanSummary = validateRuntimeSourceScan();

  console.log(JSON.stringify({
    ok: true,
    required_routes: REQUIRED_ROUTES.length,
    required_scripts: REQUIRED_PACKAGE_SCRIPTS.length,
    runtime_profiles: runtimeProfileSummary.profiles,
    runtime_teams: runtimeProfileSummary.teams,
    scanned_runtime_scopes: sourceScanSummary.scannedScopes,
    retired_gateway_runtime_surface: false,
  }, null, 2));
}

main();
