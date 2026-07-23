#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import * as reportingHub from '../packages/core/lib/reporting-hub.ts';

async function main() {
  const state = reportingHub._testOnly;
  assert.equal(typeof state?.resetDeliveryState, 'function');
  state.resetDeliveryState();

  let calls = 0;
  const sender = {
    async send() {
      calls += 1;
      return calls > 1;
    },
  };
  const event = {
    from_bot: 'jay',
    team: 'jay',
    event_type: 'delivery_state_smoke',
    alert_level: 2,
    message: 'retry after failed delivery',
  };
  const policy = { key: 'delivery-state-retry', cooldownMs: 60_000 };

  const failed = await reportingHub.publishToTelegram({ sender, topicTeam: 'jay', event, policy });
  assert.equal(failed.ok, false);
  const succeeded = await reportingHub.publishToTelegram({ sender, topicTeam: 'jay', event, policy });
  assert.equal(succeeded.ok, true);
  const deduped = await reportingHub.publishToTelegram({ sender, topicTeam: 'jay', event, policy });
  assert.equal(deduped.skipped, true);
  assert.equal(deduped.reason, 'deduped');
  assert.equal(calls, 2, 'failed delivery must remain retryable');

  state.resetDeliveryState();
  for (let index = 0; index < state.MAX_DELIVERY_STATE_ENTRIES + 5; index += 1) {
    const decision = state.evaluateDeliveryPolicy('telegram', reportingHub.normalizeEvent({
      ...event,
      message: `bounded-${index}`,
    }), { cooldownMs: 60_000 });
    state.commitDelivery(decision, true);
  }
  assert(state.deliveryStateSize() <= state.MAX_DELIVERY_STATE_ENTRIES);

  console.log('reporting_hub_delivery_state_smoke_ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
