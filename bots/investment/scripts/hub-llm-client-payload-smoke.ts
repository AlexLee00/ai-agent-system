import { createRequire } from 'module';
import {
  buildHubLlmCallPayload,
  getHubCallerTeam,
  isDirectFallbackEnabled,
  isHubEnabled,
  normalizeHubUrgency,
  resolveHubRequestTiming,
} from '../shared/hub-llm-client.ts';

const require = createRequire(import.meta.url);
const { parseLlmCallPayload } = require('../../hub/lib/llm/request-schema.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const originalHubEnabled = process.env.INVESTMENT_LLM_HUB_ENABLED;
  const originalDirectFallback = process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
  const originalTimeoutProfiles = process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED;

  try {
    assert(normalizeHubUrgency('medium') === 'normal', 'legacy medium urgency should map to Hub normal');
    assert(normalizeHubUrgency('normal') === 'normal', 'normal urgency should be preserved');
    assert(normalizeHubUrgency('critical') === 'critical', 'critical urgency should be preserved');
    assert(isHubEnabled() === true, 'investment Hub routing should be enabled by default');
    assert(isDirectFallbackEnabled() === false, 'direct LLM fallback should be disabled by default');
    process.env.INVESTMENT_LLM_HUB_ENABLED = 'false';
    assert(isHubEnabled() === false, 'explicit INVESTMENT_LLM_HUB_ENABLED=false should disable Hub only for emergency mode');
    process.env.INVESTMENT_LLM_DIRECT_FALLBACK = 'true';
    assert(isDirectFallbackEnabled() === true, 'explicit direct fallback env should be required for direct LLM bypass');
    if (originalHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = originalHubEnabled;
    if (originalDirectFallback == null) delete process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
    else process.env.INVESTMENT_LLM_DIRECT_FALLBACK = originalDirectFallback;
    assert(getHubCallerTeam() === 'luna', 'investment Hub LLM calls should use the Luna runtime profile by default');

    const hermesPayload = buildHubLlmCallPayload('hermes', 'system', 'user', {
      urgency: 'medium',
      symbol: 'BTC/USDT',
      market: 'binance',
      taskType: 'sentiment',
      maxTokens: 128,
    });
    const lunaPayload = buildHubLlmCallPayload('luna', 'system', 'user');

    assert(hermesPayload.urgency === 'normal', 'Hermes payload should not emit unsupported medium urgency');
    assert(lunaPayload.urgency === 'high', 'Luna default urgency should remain high');
    assert(hermesPayload.callerTeam === 'luna', 'Hermes payload should route through Luna team profile');
    assert(lunaPayload.callerTeam === 'luna', 'Luna payload should route through Luna team profile');
    assert(hermesPayload.selectorKey === 'investment.hermes', 'Hermes payload should use the Hermes selector key');
    assert(lunaPayload.selectorKey === 'investment.luna', 'Luna payload should use the Luna selector key');
    assert(hermesPayload.cacheEnabled === true, 'Hermes sentiment payload should enable exact-prompt cache');
    assert(hermesPayload.cacheType === 'sentiment_realtime', 'Hermes sentiment payload should use short sentiment cache TTL');
    assert(!Array.isArray(hermesPayload.chain), 'Hermes payload should not carry client-side explicit chain');

    process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED = 'true';
    const chronosPayload = buildHubLlmCallPayload('chronos', 'system', 'user', {
      market: 'binance',
      taskType: 'backtest_judgment',
    });
    const chronosTiming = resolveHubRequestTiming({
      selectorKey: String(chronosPayload.selectorKey),
      taskType: 'backtest_judgment',
    });
    assert(chronosPayload.selectorKey === 'investment.chronos', 'Chronos should retain its selector key');
    assert(chronosPayload.timeoutMs === 180_000, 'Chronos backtest profile should provide the default timeout when the caller omits it');
    assert(chronosTiming.requestTimeoutMs === 180_000, 'request timeout should use the shared selector profile');
    assert(chronosTiming.fetchTimeoutMs === 185_000, 'fetch timeout should include transport overhead');
    const explicitShortTiming = resolveHubRequestTiming({
      selectorKey: 'investment.chronos',
      taskType: 'backtest_judgment',
      timeoutMs: 30_000,
    });
    assert(explicitShortTiming.requestTimeoutMs === 30_000, 'an explicit caller timeout must remain an upper bound');
    assert(explicitShortTiming.fetchTimeoutMs === 35_000, 'transport overhead must follow the explicit request bound');
    const defaultOptInTiming = resolveHubRequestTiming({
      selectorKey: 'investment.chronos',
      taskType: 'backtest_judgment',
      env: {},
    });
    assert(defaultOptInTiming.requestTimeoutMs === 180_000, 'investment client should use shared timeout profiles by default');

    const cappedTiming = resolveHubRequestTiming({
      selectorKey: 'investment.luna',
      timeoutMs: 300_000,
      env: { ...process.env, SELECTOR_TIMEOUT_PROFILES_ENABLED: 'false' },
    });
    assert(cappedTiming.requestTimeoutMs === 180_000, 'investment client timeout must stay within the Hub default schema cap');

    const hermesParsed = parseLlmCallPayload(hermesPayload);
    const lunaParsed = parseLlmCallPayload(lunaPayload);
    const chronosParsed = parseLlmCallPayload(chronosPayload);
    assert(hermesParsed.ok, `Hermes payload should pass Hub schema: ${JSON.stringify(hermesParsed.error)}`);
    assert(lunaParsed.ok, `Luna payload should pass Hub schema: ${JSON.stringify(lunaParsed.error)}`);
    assert(chronosParsed.ok, `Chronos payload should pass Hub schema: ${JSON.stringify(chronosParsed.error)}`);

    console.log(JSON.stringify({
      ok: true,
      checked: ['urgency_mapping', 'hub_defaults', 'selector_policy', 'timeout_profile', 'hub_schema_compatibility'],
    }));
  } finally {
    if (originalHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = originalHubEnabled;
    if (originalDirectFallback == null) delete process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
    else process.env.INVESTMENT_LLM_DIRECT_FALLBACK = originalDirectFallback;
    if (originalTimeoutProfiles == null) delete process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED;
    else process.env.SELECTOR_TIMEOUT_PROFILES_ENABLED = originalTimeoutProfiles;
  }
}

await main();
