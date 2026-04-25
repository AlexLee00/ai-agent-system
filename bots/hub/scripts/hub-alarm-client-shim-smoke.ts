const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');
const openClawShim = require('../../../packages/core/lib/openclaw-client.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  assert(typeof hubAlarmClient.postAlarm === 'function', 'expected hub-alarm-client postAlarm export');
  assert(typeof openClawShim.postAlarm === 'function', 'expected openclaw-client shim postAlarm export');
  assert(openClawShim.postAlarm === hubAlarmClient.postAlarm, 'expected openclaw-client shim to re-export hub implementation');
  assert(
    openClawShim._testOnly_isHubAlarmDeliveryAccepted === hubAlarmClient._testOnly_isHubAlarmDeliveryAccepted,
    'expected delivery acceptance helper to be shared',
  );
  assert(
    openClawShim._testOnly_isLegacyWebhookFallbackEnabled === hubAlarmClient._testOnly_isLegacyWebhookFallbackEnabled,
    'expected legacy webhook fallback helper to be shared',
  );
  console.log('hub_alarm_client_shim_smoke_ok');
}

main();
