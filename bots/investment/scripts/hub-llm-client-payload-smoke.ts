import { createRequire } from 'module';
import {
  buildHubLlmCallPayload,
  getHubCallerTeam,
  isDirectFallbackEnabled,
  isHubEnabled,
  callLLMWithHub,
  normalizeHubUrgency,
} from '../shared/hub-llm-client.ts';
import * as db from '../shared/db.ts';

const require = createRequire(import.meta.url);
const { parseLlmCallPayload } = require('../../hub/lib/llm/request-schema.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function assertRejects(fn: () => Promise<unknown>, pattern: RegExp, message: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert(pattern.test(String((err as Error)?.message || err)), message);
    return;
  }
  throw new Error(message);
}

async function main(): Promise<void> {
  const originalHubEnabled = process.env.INVESTMENT_LLM_HUB_ENABLED;
  const originalDirectFallback = process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
  const incidentKey = `hub-llm-client-payload-smoke:${Date.now()}`;

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
      maxTokens: 128,
    });
    const lunaPayload = buildHubLlmCallPayload('luna', 'system', 'user');

    assert(hermesPayload.urgency === 'normal', 'Hermes payload should not emit unsupported medium urgency');
    assert(lunaPayload.urgency === 'high', 'Luna default urgency should remain high');
    assert(hermesPayload.callerTeam === 'luna', 'Hermes payload should route through Luna team profile');
    assert(lunaPayload.callerTeam === 'luna', 'Luna payload should route through Luna team profile');
    assert(hermesPayload.selectorKey === 'investment.agent_policy', 'Hermes payload should use the investment selector policy');
    assert(lunaPayload.selectorKey === 'investment.agent_policy', 'Luna payload should use the investment selector policy');

    const hermesParsed = parseLlmCallPayload(hermesPayload);
    const lunaParsed = parseLlmCallPayload(lunaPayload);
    assert(hermesParsed.ok, `Hermes payload should pass Hub schema: ${JSON.stringify(hermesParsed.error)}`);
    assert(lunaParsed.ok, `Luna payload should pass Hub schema: ${JSON.stringify(lunaParsed.error)}`);

    process.env.INVESTMENT_LLM_HUB_ENABLED = 'false';
    delete process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
    await assertRejects(
      () => callLLMWithHub('luna', 'system', 'user', async () => 'direct-result', 32, { incidentKey }),
      /INVESTMENT_LLM_DIRECT_FALLBACK=true/,
      'Hub disabled mode must fail closed unless direct fallback is explicitly enabled',
    );
    process.env.INVESTMENT_LLM_DIRECT_FALLBACK = 'true';
    const directBypass = await callLLMWithHub('luna', 'system', 'user', async () => 'direct-result', 32, { incidentKey });
    assert(directBypass === 'direct-result', 'explicit direct fallback should allow emergency direct bypass');
    if (originalHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = originalHubEnabled;
    if (originalDirectFallback == null) delete process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
    else process.env.INVESTMENT_LLM_DIRECT_FALLBACK = originalDirectFallback;

    console.log(JSON.stringify({
      ok: true,
      checked: ['urgency_mapping', 'hub_defaults', 'selector_policy', 'hub_schema_compatibility', 'direct_fallback_fail_closed'],
    }));
  } finally {
    if (originalHubEnabled == null) delete process.env.INVESTMENT_LLM_HUB_ENABLED;
    else process.env.INVESTMENT_LLM_HUB_ENABLED = originalHubEnabled;
    if (originalDirectFallback == null) delete process.env.INVESTMENT_LLM_DIRECT_FALLBACK;
    else process.env.INVESTMENT_LLM_DIRECT_FALLBACK = originalDirectFallback;
    await db.run(`DELETE FROM investment.llm_routing_log WHERE incident_key = $1`, [incidentKey]).catch(() => null);
  }
}

await main();
