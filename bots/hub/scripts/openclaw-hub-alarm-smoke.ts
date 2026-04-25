const { _testOnly_isHubAlarmDeliveryAccepted } = require('../../../packages/core/lib/hub-alarm-client.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  assert(
    _testOnly_isHubAlarmDeliveryAccepted({ ok: true }, { ok: true, delivered: true }) === true,
    'expected delivered=true accepted',
  );
  assert(
    _testOnly_isHubAlarmDeliveryAccepted({ ok: true }, { ok: true, deduped: true, delivered: false }) === true,
    'expected deduped accepted',
  );
  assert(
    _testOnly_isHubAlarmDeliveryAccepted(
      { ok: true },
      { ok: true, governed: true, visibility: 'digest', delivered: false },
    ) === true,
    'expected governed digest accepted without immediate delivery',
  );
  assert(
    _testOnly_isHubAlarmDeliveryAccepted({ ok: true }, { ok: true, suppressed: true, delivered: false }) === false,
    'expected suppressed rejected',
  );
  assert(
    _testOnly_isHubAlarmDeliveryAccepted({ ok: true }, { ok: true, delivered: false, delivery_error: 'x' }) === false,
    'expected delivered=false rejected',
  );
  console.log('hub_alarm_client_smoke_ok');
}

main();
