import assert from 'node:assert/strict';
import { buildErrorAlertEnvelope } from '../shared/report.ts';

async function main() {
  const err = /** @type {any} */ (new Error('Binance MCP bridge failed (market_buy): binance Market is closed.'));
  err.code = 'binance_mcp_mutating_bridge_failed';
  const captured = buildErrorAlertEnvelope('헤파이스토스 - UTK/USDT BUY', err);

  assert.equal(captured.eventType, 'report');
  assert.equal(captured.alertLevel, 2);
  assert.equal(captured.visibility, 'digest');
  assert.equal(captured.alarmType, 'report');
  assert.equal(captured.actionability, 'none');
  assert.match(String(captured.title || ''), /Binance 장마감 거절/);
  assert.match(String(captured.header || ''), /운영상태/);

  console.log('luna error alert routing smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
