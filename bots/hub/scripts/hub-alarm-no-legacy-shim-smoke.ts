const fs = require('fs');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const coreLibDir = path.resolve(__dirname, '..', '..', '..', 'packages', 'core', 'lib');
  const retiredNames = [
    `open${'claw'}-client.ts`,
    `open${'claw'}-client.js`,
    `open${'claw'}-client.legacy.js`,
  ];

  for (const name of retiredNames) {
    assert(!fs.existsSync(path.join(coreLibDir, name)), `retired alarm shim still exists: ${name}`);
  }

  const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');
  assert(typeof hubAlarmClient.postAlarm === 'function', 'expected hub-alarm-client postAlarm export');
  assert(
    typeof hubAlarmClient._testOnly_isHubAlarmDeliveryAccepted === 'function',
    'expected delivery acceptance helper to be exported by hub-alarm-client',
  );
  assert(
    !Object.prototype.hasOwnProperty.call(hubAlarmClient, '_testOnly_isLegacyWebhookFallbackEnabled'),
    'expected retired legacy webhook fallback helper to be absent',
  );

  console.log('hub_alarm_no_legacy_shim_smoke_ok');
}

main();
