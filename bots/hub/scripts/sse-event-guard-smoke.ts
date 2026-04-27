#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const { parseSseJsonEvents, readSseJsonEvents, summarizeSseGuard } = require('../../../packages/core/lib/sse-event-guard');

function responseFromSse(text: string) {
  return new Response(text, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function main() {
  const ok = await parseSseJsonEvents(responseFromSse([
    'data: {"type":"response.output_text.delta","delta":"hello"}',
    '',
    'data: {"type":"response.output_text.done","text":"hello"}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')), { source: 'smoke' });
  assert.equal(ok.events.length, 2);
  assert.equal(ok.summary.malformed_fragments, 0);

  const malformed = await parseSseJsonEvents(responseFromSse([
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    '',
    'data: {"type":',
    '',
    'data: {"type":"tool.untrusted","token":"redacted-by-design"}',
    '',
    '',
  ].join('\n')), { source: 'smoke', trustedTypes: ['response.output_text.delta'] });
  assert.equal(malformed.events.length, 2);
  assert.equal(malformed.summary.malformed_fragments, 1);
  assert.equal(malformed.summary.untrusted_events.length, 1);
  assert.match(summarizeSseGuard(malformed.summary), /untrusted=1/);

  const oversized = await parseSseJsonEvents(responseFromSse(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(2048) })}\n\n`), {
    source: 'smoke',
    maxEventBytes: 1024,
  });
  assert.equal(oversized.events.length, 0);
  assert.equal(oversized.summary.oversized_fragments, 1);

  const eventsOnly = await readSseJsonEvents(responseFromSse('data: {"type":"response.done","response":{}}\n\n'));
  assert.equal(eventsOnly.length, 1);

  console.log(JSON.stringify({
    ok: true,
    normal_events: ok.events.length,
    malformed_fragments: malformed.summary.malformed_fragments,
    oversized_fragments: oversized.summary.oversized_fragments,
    untrusted_events: malformed.summary.untrusted_events.length,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
