#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(__filename);

const originalEnv = {
  HUB_LLM_GEMINI_DISABLED: process.env.HUB_LLM_GEMINI_DISABLED,
  HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES: process.env.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES,
  HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI: process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI,
  HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE: process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE,
};
const originalFetch = globalThis.fetch;

async function main() {
  delete process.env.HUB_LLM_GEMINI_DISABLED;

  const selector = require('../src/llm-selector.ts');
  const unified = require('../lib/llm/unified-caller.ts');
  const oauthDirect = require('../lib/llm/oauth-direct.ts');
  const oauthMonitor = require('./run-oauth-monitor.ts')._testOnly;
  const retirement = require('../../../packages/core/lib/llm-provider-retirement.ts');
  const coreSelector = require('../../../packages/core/lib/llm-model-selector.ts');
  const secretsRoute = require('../lib/routes/secrets.ts');
  const toolRegistrySource = fs.readFileSync(path.join(__dirname, '../lib/control/tool-registry.ts'), 'utf8');
  const secretsRouteSource = fs.readFileSync(path.join(__dirname, '../lib/routes/secrets.ts'), 'utf8');
  const fallbackSource = fs.readFileSync(path.join(__dirname, '../../../packages/core/lib/llm-fallback.ts'), 'utf8');

  assert.equal(selector.isGeminiDisabled(), true, 'Gemini must fail closed when the env flag is absent');
  assert.equal(oauthDirect._testOnly.isGeminiDisabled(), true, 'direct Gemini calls must fail closed when the env flag is absent');
  assert.equal(oauthMonitor.geminiLlmDisabled(), true, 'OAuth monitor must fail closed when the env flag is absent');

  process.env.HUB_LLM_GEMINI_DISABLED = 'false';
  process.env.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES = 'true';
  assert.equal(selector.isGeminiDisabled(), true, 'retirement must ignore an env re-enable request');
  assert.equal(oauthDirect._testOnly.isGeminiDisabled(), true, 'direct caller must ignore an env re-enable request');
  assert.equal(oauthMonitor.geminiLlmDisabled(), true, 'OAuth monitor must ignore an env re-enable request');
  assert.equal(retirement.getGeminiRetirementState().overrideRequested, true, 'conflicting env must remain observable');
  assert.equal(retirement.isGeminiProvider('gemini-cli/gemini-2.5-flash'), true, 'legacy Gemini CLI routes must remain retired');
  assert.equal(retirement.isGeminiProvider('google-gemini-cli/gemini-2.5-flash'), true, 'Google Gemini CLI aliases must remain retired');
  assert.equal(retirement.isGeminiProvider('google/gemini-2.5-flash'), true, 'provider-qualified Gemini models must remain retired');
  assert.equal(retirement.isGeminiProvider('openrouter/google/gemini-2.5-pro'), true, 'nested Gemini model routes must remain retired');
  assert.equal(retirement.isGeminiProvider('openrouter/google/gemini'), true, 'exact nested Gemini route segments must remain retired');

  const hostileModelOverrideProbe = spawnSync(process.execPath, [
    '--disable-warning=DEP0205',
    '--import',
    'tsx',
    '-e',
    `
      const selector = require('./packages/core/lib/llm-model-selector.ts');
      const retirement = require('./packages/core/lib/llm-provider-retirement.ts');
      const activeConstants = [
        'OPENAI_PERF_MODEL',
        'OPENAI_MINI_MODEL',
        'OPENAI_OPUS_MODEL',
        'GROQ_FAST_MODEL',
        'GROQ_DEEP_MODEL',
        'GROQ_SCOUT_MODEL',
        'LOCAL_EMBED_MODEL',
      ];
      const constantFindings = activeConstants.filter((name) => retirement.isGeminiProvider(selector[name]));
      const selectorFindings = selector.listLLMSelectorKeys().flatMap((key) => selector.selectLLMChain(key, {
        selectorVersion: 'v3.0_oauth_4',
        rolloutPercent: 100,
        rolloutKey: 'hostile-gemini-model-env:' + key,
      }).filter((entry) => retirement.isGeminiProvider(entry.provider) || retirement.isGeminiProvider(entry.model))
        .map((entry) => key + ':' + entry.provider + '/' + entry.model));
      if (constantFindings.length || selectorFindings.length) {
        throw new Error(JSON.stringify({ constantFindings, selectorFindings }));
      }
      console.log(JSON.stringify({ ok: true }));
    `,
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: {
      ...process.env,
      LLM_OPENAI_PERF_MODEL: 'openai-oauth/gemini-cli-oauth/gemini-2.5-pro',
      LLM_OPENAI_MINI_MODEL: 'google/gemini-2.5-flash',
      LLM_OPENAI_OPUS_MODEL: 'openrouter/google/gemini',
      LLM_GROQ_FAST_MODEL: 'groq/gemini-2.5-flash',
      LLM_GROQ_DEEP_MODEL: 'openrouter/google/gemini-2.5-pro',
      LLM_GROQ_SCOUT_MODEL: 'gemini-codeassist-oauth/gemini-2.5-flash',
      LLM_LOCAL_EMBED_MODEL: 'local-embedding/google/gemini-embedding-001',
    },
    encoding: 'utf8',
  });
  assert.equal(
    hostileModelOverrideProbe.status,
    0,
    `active model env overrides must not reintroduce Gemini: ${hostileModelOverrideProbe.stderr}`,
  );
  assert(toolRegistrySource.includes('getGeminiRetirementState'), 'OAuth ops status must use the shared retirement policy');
  assert(!toolRegistrySource.includes("getProviderRecord('gemini-cli-oauth')"), 'OAuth ops status must not read retired Gemini credentials');
  assert(!secretsRouteSource.includes('gemini: store.gemini'), 'Hub secrets must not expose retired Gemini keys');
  assert(!secretsRouteSource.includes('c.gemini?.api_key'), 'Hub config fallback must not expose retired Gemini keys');
  assert(fallbackSource.includes('assertProviderNotRetired(provider);'), 'fallback must reject a retired provider');
  assert(fallbackSource.includes('assertProviderNotRetired(model);'), 'fallback must reject a retired model even when its provider is mislabeled');

  const policyEntries = (policy: any): any[] => {
    if (Array.isArray(policy)) return policy;
    if (!policy || typeof policy !== 'object') return [];
    return [
      policy,
      policy.primary,
      policy.fallback,
      ...(Array.isArray(policy.fallbacks) ? policy.fallbacks : []),
      ...(Array.isArray(policy.chain) ? policy.chain : []),
      ...(Array.isArray(policy.fallbackChain) ? policy.fallbackChain : []),
    ].filter((entry) => entry && typeof entry === 'object' && (entry.provider || entry.model));
  };
  const exposedGeminiPolicies = coreSelector.listLLMSelectorKeys().flatMap((key: string) => (
    policyEntries(coreSelector.selectLLMPolicy(key, {
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
      rolloutKey: `gemini-public-policy:${key}`,
    }))
      .filter((entry: any) => retirement.isGeminiProvider(entry.provider) || retirement.isGeminiProvider(entry.model))
      .map((entry: any) => `${key}:${entry.provider || ''}/${entry.model || ''}`)
  ));
  assert.deepEqual(exposedGeminiPolicies, [], 'public selector policy API must not expose retired Gemini entries');

  const disguisedPolicy = coreSelector.selectLLMPolicy('hub._default', {
    selectorVersion: 'v3.0_oauth_4',
    rolloutPercent: 100,
    rolloutKey: 'gemini-public-policy:disguised-provider',
    policyOverride: {
      primary: { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
      fallback: { provider: 'openai-oauth', model: 'openrouter/google/gemini-2.5-flash' },
      fallbacks: [
        { provider: 'google', model: 'gemini-2.5-flash' },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
      ],
      chain: [
        { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
      ],
      fallbackChain: [
        { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
        { provider: 'openai-oauth', model: 'openrouter/google/gemini-2.5-flash' },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
      ],
    },
  });
  assert.deepEqual(
    policyEntries(disguisedPolicy).filter((entry: any) => (
      retirement.isGeminiProvider(entry.provider) || retirement.isGeminiProvider(entry.model)
    )),
    [],
    'public selector policy must reject provider/model-split Gemini overrides',
  );

  const publicPolicyTargets = [
    ...coreSelector.listLLMSelectorKeys().map((selectorKey: string) => ({ selectorKey, agentName: null })),
    ...coreSelector.listLlmRouteTargets({
      includeInternal: true,
      includeAliases: true,
      includeBlocked: false,
    }).map((target: any) => ({
      selectorKey: target.selectorKey,
      agentName: target.agent,
    })),
  ];
  const exposedRetiredAbstractRoutes = publicPolicyTargets.flatMap(({ selectorKey, agentName }: any) => {
    if (!selectorKey) return [];
    const policy = coreSelector.selectLLMPolicy(selectorKey, {
      ...(agentName ? { agentName } : {}),
      selectorVersion: 'v3.0_oauth_4',
      rolloutPercent: 100,
      rolloutKey: `gemini-public-route:${selectorKey}:${agentName || 'default'}`,
    });
    return /gemini/i.test(String(policy?.route || ''))
      ? [`${selectorKey}:${agentName || 'default'}:${policy.route}`]
      : [];
  });
  assert.deepEqual(exposedRetiredAbstractRoutes, [], 'public selector policies must not expose retired Gemini abstract routes');

  for (const abstractRoute of ['gemini_flash', 'gemini_flash_lite', 'anthropic_haiku']) {
    const entry = coreSelector.routeEntryFromAbstractRoute(abstractRoute, 'v3_oauth_4');
    assert.equal(
      retirement.isGeminiProvider(entry?.provider) || retirement.isGeminiProvider(entry?.model),
      false,
      `public abstract route resolver must not reconstruct Gemini for ${abstractRoute}`,
    );
  }

  const sanitizedConfig = secretsRoute._testOnly.sanitizeConfig({
    gemini: { api_key: 'must-not-leak', image_api_key: 'must-not-leak' },
    providers: { gemini_oauth: { refresh_token: 'must-not-leak' }, openai: { model: 'gpt-5.4' } },
    google: { maps_api_key: 'must-remain' },
  });
  assert.equal(sanitizedConfig.gemini, undefined, 'generic config must remove the retired Gemini section');
  assert.equal(sanitizedConfig.providers?.gemini_oauth, undefined, 'generic config must remove nested Gemini aliases');
  assert.equal(sanitizedConfig.providers?.openai?.model, 'gpt-5.4', 'non-Gemini provider config must remain');
  assert.equal(sanitizedConfig.google?.maps_api_key, 'must-remain', 'unrelated Google configuration must remain');

  assert.equal(selector.isGeminiDisabled(), true);
  assert.equal(Object.prototype.hasOwnProperty.call(selector.getActiveProviderTiers(), 'gemini-cli-oauth'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(selector.getActiveProviderTiers(), 'gemini-codeassist-oauth'), false);

  const mixedSelection = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    agent: 'oauth-monitor',
    chain: [
      { provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash' },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
    ],
  }, { allowAdhocChain: true });
  assert.equal(mixedSelection.ok, true);
  assert.equal(mixedSelection.disabledProvidersRemoved, 1);
  assert.deepEqual(mixedSelection.chain.map((entry: any) => entry.provider), ['openai-oauth']);

  const allGeminiSelection = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    agent: 'oauth-monitor',
    chain: [
      { provider: 'gemini-codeassist-oauth', model: 'gemini-2.5-pro' },
      { provider: 'gemini-oauth', model: 'gemini-2.5-flash' },
    ],
  }, { allowAdhocChain: true });
  assert.equal(allGeminiSelection.ok, false);
  assert.equal(allGeminiSelection.error, 'gemini_provider_disabled');
  assert.equal(allGeminiSelection.disabledProvidersRemoved, 2);

  const disguisedGeminiSelection = selector.resolveHubLlmSelection({
    callerTeam: 'hub',
    agent: 'oauth-monitor',
    chain: [
      { provider: 'openrouter', model: 'google/gemini-2.5-pro' },
      { provider: 'google', model: 'gemini-2.5-flash' },
      { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
    ],
  }, { allowAdhocChain: true });
  assert.equal(disguisedGeminiSelection.ok, true);
  assert.equal(disguisedGeminiSelection.disabledProvidersRemoved, 2);
  assert.deepEqual(
    disguisedGeminiSelection.chain.map((entry: any) => entry.provider),
    ['openai-oauth'],
    'provider/model split must not disguise a retired Gemini route',
  );

  assert.equal(unified._testOnly._isGeminiProvider('gemini-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('gemini-cli-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('gemini-codeassist-oauth'), true);
  assert.equal(unified._testOnly._isGeminiProvider('openai-oauth'), false);

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('disabled Gemini guard must return before network');
  }) as typeof fetch;

  for (const result of [
    await oauthDirect.callGeminiOAuth({ model: 'gemini-oauth/gemini-2.5-flash', prompt: 'x' }),
    await oauthDirect.callGeminiCliOAuth({ model: 'gemini-cli-oauth/gemini-2.5-flash', prompt: 'x' }),
    await oauthDirect.callGeminiCodeAssistOAuth({ model: 'gemini-codeassist-oauth/gemini-2.5-pro', prompt: 'x' }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error, 'gemini_provider_disabled');
  }
  assert.equal(fetchCalls, 0);

  process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI = 'true';
  process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE = 'true';
  assert.equal(oauthMonitor.geminiLlmDisabled(), true);
  assert.equal(oauthMonitor.geminiCliMonitorRequired(), false);
  assert.equal(oauthMonitor.geminiCodeAssistServiceRequired(), false);

  const monitorResult = await oauthMonitor.checkGeminiCliOAuth();
  assert.equal(monitorResult.healthy, true);
  assert.equal(monitorResult.skipped, true);
  assert.equal(monitorResult.disabled, true);
  assert.equal(monitorResult.needs_refresh, false);
  assert.equal(monitorResult.credential_refresh_ok, null);
  assert.equal(monitorResult.live_refresh_attempts, 0);
  assert.equal(monitorResult.error, 'gemini_provider_disabled');

  const serviceResult = await oauthMonitor.checkGeminiCodeAssistService();
  assert.equal(serviceResult.healthy, true);
  assert.equal(serviceResult.skipped, true);
  assert.equal(serviceResult.required, false);
  assert.equal(serviceResult.error, 'gemini_provider_disabled');

  const probeResult = await oauthMonitor.runGeminiCliLiveRefreshProbe();
  assert.equal(probeResult.ok, false);
  assert.equal(probeResult.skipped, true);
  assert.equal(probeResult.attempts, 0);
  assert.equal(probeResult.error, 'gemini_provider_disabled');

  const retiredScripts = [
    ['gemini-cli-oauth-import.ts', ['--dry-run']],
    ['gemini-cli-oauth-readiness.ts', ['--json']],
    ['gemini-codeassist-service-status.ts', ['--json']],
    ['steward-gemini-model-drill.ts', ['--json', '--mock']],
  ];
  for (const [script, args] of retiredScripts) {
    const child = spawnSync(process.execPath, [
      '--disable-warning=DEP0205',
      '--import',
      'tsx',
      path.join(__dirname, String(script)),
      ...(args as string[]),
    ], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        HUB_LLM_GEMINI_DISABLED: 'false',
        HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES: 'true',
      },
    });
    assert.equal(child.status, 0, `${script} must exit cleanly in retired mode: ${child.stderr || child.stdout}`);
    assert.match(child.stdout, /"skipped":true/, `${script} must report a skipped retirement result`);
    assert.match(child.stdout, /"retired":true/, `${script} must report retirement`);
  }

  const hostileAmbientEnv = {
    ...process.env,
    LLM_CLAUDE_CODE_DISABLED: 'true',
    LUNA_YAML_ROUTING_ENABLED: 'false',
    LLM_GROQ_FAST_MODEL: 'ambient-invalid-fast-model',
    LLM_GROQ_DEEP_MODEL: 'ambient-invalid-deep-model',
    LLM_GROQ_SCOUT_MODEL: 'ambient-invalid-scout-model',
    SELECTOR_TIMEOUT_MS_BLOG_POS_WRITER: '77777',
    ARCHER_TIMEOUT_MS: '77777',
  };
  const codegenCheck = spawnSync(process.execPath, [
    '--import',
    'tsx',
    path.join(__dirname, 'llm-policy-table-codegen.ts'),
    '--check',
    '--env-from-launchd',
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    env: hostileAmbientEnv,
  });
  assert.equal(
    codegenCheck.status,
    0,
    `retirement codegen must ignore unrelated ambient provider flags: ${codegenCheck.stderr || codegenCheck.stdout}`,
  );

  const snapshotCheck = spawnSync(process.execPath, [
    '--import',
    'tsx',
    path.join(__dirname, 'llm-chain-snapshot.ts'),
    '--no-write',
    '--env-from-launchd',
    '--json',
  ], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    encoding: 'utf8',
    env: hostileAmbientEnv,
  });
  assert.equal(
    snapshotCheck.status,
    0,
    `snapshot generation must ignore unrelated ambient selector flags: ${snapshotCheck.stderr || snapshotCheck.stdout}`,
  );
  const generatedSnapshot = JSON.parse(snapshotCheck.stdout);
  const baselineSnapshot = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../docs/hub/snapshots/llm-chain-snapshot-2026-07-19.json'),
    'utf8',
  ));
  const snapshotRow = (snapshot: any, key: string) => snapshot.variants.find((row: any) => (
    row.key === key && row.variant === 'default' && row.agentName == null
  ));
  assert.deepEqual(
    snapshotRow(generatedSnapshot, 'blog.pos.writer')?.chain,
    snapshotRow(baselineSnapshot, 'blog.pos.writer')?.chain,
    'launchd snapshot must not inherit dynamic selector timeout overrides',
  );

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-retirement-codegen-'));
  try {
    const fixtureSnapshotPath = path.join(fixtureDir, 'snapshot.json');
    const fixtureOutputPath = path.join(fixtureDir, 'policy-table.ts');
    fs.writeFileSync(fixtureSnapshotPath, JSON.stringify({
      generatedAt: '2026-07-19T00:00:00.000Z',
      selectorVersion: 'fixture',
      variants: [{
        key: 'fixture.retired-route',
        variant: 'default',
        chain: [{ provider: 'gemini-cli-oauth', model: 'gemini-2.5-flash' }],
        error: null,
      }],
    }));
    const retiredRouteCheck = spawnSync(process.execPath, [
      '--import',
      'tsx',
      path.join(__dirname, 'llm-policy-table-codegen.ts'),
      '--snapshot',
      fixtureSnapshotPath,
      '--out',
      fixtureOutputPath,
    ], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.notEqual(retiredRouteCheck.status, 0, 'codegen must reject a snapshot containing a retired Gemini route');
    assert.match(
      `${retiredRouteCheck.stderr}\n${retiredRouteCheck.stdout}`,
      /retired Gemini route in snapshot/,
      'codegen failure must identify the retired Gemini route boundary',
    );
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    geminiDisabled: selector.isGeminiDisabled(),
    mixedSelectionProviders: mixedSelection.chain.map((entry: any) => entry.provider),
    disabledDirectCalls: 3,
    retiredOperationalScripts: retiredScripts.length,
    codegenAmbientEnvStable: true,
    codegenRetiredRouteRejected: true,
    oauthMonitorSkipped: true,
  }));
}

main()
  .catch((error) => {
    console.error('[gemini-disabled-guard-smoke] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv.HUB_LLM_GEMINI_DISABLED == null) delete process.env.HUB_LLM_GEMINI_DISABLED;
    else process.env.HUB_LLM_GEMINI_DISABLED = originalEnv.HUB_LLM_GEMINI_DISABLED;
    if (originalEnv.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES == null) delete process.env.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES;
    else process.env.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES = originalEnv.HUB_LLM_ALLOW_GEMINI_ACTIVE_ROUTES;
    if (originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI == null) delete process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI;
    else process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI = originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CLI;
    if (originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE == null) delete process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE;
    else process.env.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE = originalEnv.HUB_OAUTH_MONITOR_REQUIRE_GEMINI_CODEASSIST_SERVICE;
  });
