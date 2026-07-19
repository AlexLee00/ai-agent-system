function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

async function main() {
  const originalBaseUrl = process.env.HUB_BASE_URL;
  const originalToken = process.env.HUB_AUTH_TOKEN;
  const originalFetch = global.fetch;
  process.env.HUB_BASE_URL = 'http://hub-alarm-client-smoke.local';
  process.env.HUB_AUTH_TOKEN = 'smoke-token';
  const clientPath = require.resolve('../../../packages/core/lib/hub-alarm-client.ts');
  delete require.cache[clientPath];
  const {
    _testOnly_isHubAlarmDeliveryAccepted,
    postAlarmAutoRepairResult,
  } = require(clientPath);

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

  try {
    global.fetch = async () => new Response(JSON.stringify({
      ok: true,
      event_id: 4321,
      mirror_update: { ok: true, updated: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const delivered = await postAlarmAutoRepairResult({
      incidentKey: 'smoke:auto-repair-client',
      alarmEventId: 'generation-1',
      status: 'resolved',
    });
    assert(delivered.ok === true, 'expected successful callback response');
    assert(delivered.eventId === 4321, 'callback event_id must be exposed to manifest callers');

    global.fetch = async () => new Response(JSON.stringify({
      ok: false,
      retryable: true,
      retry_after_ms: 275000,
      event_id: 4321,
      error: 'telegram_delivery_in_progress',
      mirror_update: { ok: true, updated: 0 },
    }), { status: 503, headers: { 'content-type': 'application/json' } });
    const leased = await postAlarmAutoRepairResult({
      incidentKey: 'smoke:auto-repair-client',
      alarmEventId: 'generation-1',
      status: 'resolved',
    });
    assert(leased.ok === false && leased.retryable === true, 'active lease must remain retryable');
    assert(leased.retryAfterMs === 275000, 'Hub retry_after_ms must reach the callback scheduler');
  } finally {
    global.fetch = originalFetch;
    if (originalBaseUrl == null) delete process.env.HUB_BASE_URL;
    else process.env.HUB_BASE_URL = originalBaseUrl;
    if (originalToken == null) delete process.env.HUB_AUTH_TOKEN;
    else process.env.HUB_AUTH_TOKEN = originalToken;
    delete require.cache[clientPath];
  }
  console.log('hub_alarm_client_smoke_ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
