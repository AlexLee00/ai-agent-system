const hubAlarmClient = require('../../../packages/core/lib/hub-alarm-client.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function main() {
  withEnv({
    HUB_ALARM_LEGACY_WEBHOOK_FALLBACK: 'true',
  }, () => {
    assert(
      !Object.prototype.hasOwnProperty.call(hubAlarmClient, '_testOnly_isLegacyWebhookFallbackEnabled'),
      'expected retired legacy webhook fallback helper to be absent',
    );
  });

  withEnv({
    HUB_ALARM_LEGACY_WEBHOOK_FALLBACK: null,
  }, () => {
    assert(
      !Object.prototype.hasOwnProperty.call(hubAlarmClient, '_testOnly_isLegacyWebhookFallbackEnabled'),
      'expected fallback helper to remain absent by default',
    );
  });

  console.log('hub_alarm_env_smoke_ok');
}

main();
