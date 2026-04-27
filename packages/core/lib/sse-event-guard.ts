'use strict';

const DEFAULT_MAX_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MALFORMED_EVENTS = 20;

const DEFAULT_TRUSTED_EVENT_TYPES = new Set([
  'error',
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.content_part.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
]);

function safeString(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getReadableBody(input) {
  if (!input) return null;
  if (input.body && typeof input.body.getReader === 'function') return input.body;
  if (typeof input.getReader === 'function') return input;
  return null;
}

function normalizeTrustedTypes(value) {
  if (!value) return DEFAULT_TRUSTED_EVENT_TYPES;
  return new Set(Array.from(value).map((item) => safeString(item)).filter(Boolean));
}

function buildSummary({ source, events, malformedFragments, oversizedFragments, untrustedEvents, bytesRead }) {
  return {
    source,
    events: events.length,
    malformed_fragments: malformedFragments,
    oversized_fragments: oversizedFragments,
    untrusted_events: untrustedEvents,
    bytes_read: bytesRead,
  };
}

async function parseSseJsonEvents(input, options = {}) {
  const source = safeString(options.source, 'sse');
  const body = getReadableBody(input);
  const maxEventBytes = Math.max(1024, Number(options.maxEventBytes || DEFAULT_MAX_EVENT_BYTES));
  const maxTotalBytes = Math.max(maxEventBytes, Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES));
  const maxMalformedEvents = Math.max(1, Number(options.maxMalformedEvents || DEFAULT_MAX_MALFORMED_EVENTS));
  const trustedTypes = normalizeTrustedTypes(options.trustedTypes);
  const events = [];
  const untrustedEvents = [];
  let malformedFragments = 0;
  let oversizedFragments = 0;
  let bytesRead = 0;

  if (!body) {
    return {
      events,
      summary: buildSummary({ source, events, malformedFragments, oversizedFragments, untrustedEvents, bytesRead }),
    };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value?.byteLength || 0;
      if (bytesRead > maxTotalBytes) {
        oversizedFragments += 1;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (Buffer.byteLength(chunk, 'utf8') > maxEventBytes) {
          oversizedFragments += 1;
          idx = buffer.indexOf('\n\n');
          continue;
        }
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n')
          .trim();
        if (data && data !== '[DONE]') {
          try {
            const event = JSON.parse(data);
            const type = safeString(event?.type, 'unknown');
            if (!trustedTypes.has(type)) {
              untrustedEvents.push({ index: events.length, type });
            }
            events.push(event);
          } catch {
            malformedFragments += 1;
            if (malformedFragments >= maxMalformedEvents) {
              return {
                events,
                summary: buildSummary({ source, events, malformedFragments, oversizedFragments, untrustedEvents, bytesRead }),
              };
            }
          }
        }
        idx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }

  return {
    events,
    summary: buildSummary({ source, events, malformedFragments, oversizedFragments, untrustedEvents, bytesRead }),
  };
}

async function readSseJsonEvents(input, options = {}) {
  const parsed = await parseSseJsonEvents(input, options);
  return parsed.events;
}

function summarizeSseGuard(summary) {
  if (!summary || typeof summary !== 'object') return '';
  return [
    `source=${safeString(summary.source, 'sse')}`,
    `events=${Number(summary.events || 0)}`,
    `malformed=${Number(summary.malformed_fragments || 0)}`,
    `oversized=${Number(summary.oversized_fragments || 0)}`,
    `untrusted=${Array.isArray(summary.untrusted_events) ? summary.untrusted_events.length : 0}`,
  ].join(' ');
}

module.exports = {
  DEFAULT_TRUSTED_EVENT_TYPES,
  parseSseJsonEvents,
  readSseJsonEvents,
  summarizeSseGuard,
};

