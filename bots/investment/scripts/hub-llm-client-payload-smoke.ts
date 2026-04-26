import { createRequire } from 'module';
import { buildHubLlmCallPayload, getHubCallerTeam, normalizeHubUrgency } from '../shared/hub-llm-client.ts';

const require = createRequire(import.meta.url);
const { parseLlmCallPayload } = require('../../hub/lib/llm/request-schema.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  assert(normalizeHubUrgency('medium') === 'normal', 'legacy medium urgency should map to Hub normal');
  assert(normalizeHubUrgency('normal') === 'normal', 'normal urgency should be preserved');
  assert(normalizeHubUrgency('critical') === 'critical', 'critical urgency should be preserved');
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

  const hermesParsed = parseLlmCallPayload(hermesPayload);
  const lunaParsed = parseLlmCallPayload(lunaPayload);
  assert(hermesParsed.ok, `Hermes payload should pass Hub schema: ${JSON.stringify(hermesParsed.error)}`);
  assert(lunaParsed.ok, `Luna payload should pass Hub schema: ${JSON.stringify(lunaParsed.error)}`);

  console.log(JSON.stringify({
    ok: true,
    checked: ['urgency_mapping', 'hub_schema_compatibility'],
  }));
}

main();
