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
    HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: 'true',
    OPENCLAW_LEGACY_FALLBACK: null,
  }, () => {
    assert(
      hubAlarmClient._testOnly_isLegacyWebhookFallbackEnabled() === true,
      'expected HUB_ALARM_LEGACY_OPENCLAW_FALLBACK=true to enable fallback',
    );
  });

  withEnv({
    HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: null,
    OPENCLAW_LEGACY_FALLBACK: 'true',
  }, () => {
    assert(
      hubAlarmClient._testOnly_isLegacyWebhookFallbackEnabled() === true,
      'expected legacy OPENCLAW_LEGACY_FALLBACK=true to remain compatible',
    );
  });

  withEnv({
    HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: null,
    OPENCLAW_LEGACY_FALLBACK: null,
  }, () => {
    assert(
      hubAlarmClient._testOnly_isLegacyWebhookFallbackEnabled() === false,
      'expected fallback disabled by default',
    );
  });

  console.log('hub_alarm_env_smoke_ok');
}

main();
