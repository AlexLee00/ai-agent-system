'use strict';

const { isAlertMuted, isEventMuted } = require('../lib/mute-manager');
const { shouldDefer, deferToMorning } = require('../lib/night-handler');
const { formatBatch, buildSingleDelivery } = require('../lib/batch-formatter');
const { getEventHeadline } = require('../../../packages/core/lib/reporting-hub');

const DEDUP_WINDOW_MS = 60_000;
const _recent = new Map();

function buildBatchKey(item) {
  const headline = getEventHeadline(item)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return [
    item.from_bot || 'unknown',
    item.team || 'general',
    item.event_type || 'report',
    headline || 'no-headline',
  ].join(':');
}

async function processItem(item, onSend) {
  if (await isAlertMuted(item.from_bot, item.team)) return 'muted';
  if (await isEventMuted(item.from_bot, item.event_type)) return 'muted';

  if (shouldDefer(item.alert_level)) {
    await deferToMorning(item.id, getEventHeadline(item).slice(0, 60), [item.from_bot]);
    return 'deferred';
  }

  if (item.alert_level <= 2) {
    const key = buildBatchKey(item);
    if (_recent.has(key)) {
      _recent.get(key).items.push(item);
      return 'batched';
    }

    const batch = { items: [item] };
    batch.timer = setTimeout(() => {
      _recent.delete(key);
      void onSend(formatBatch(item.from_bot, batch.items), batch.items);
    }, DEDUP_WINDOW_MS);

    _recent.set(key, batch);
    return 'batched';
  }

  const ok = await onSend(buildSingleDelivery(item), item);
  return ok ? 'sent' : 'error';
}

function flushAll(onSend) {
  for (const [key, batch] of _recent.entries()) {
    clearTimeout(batch.timer);
    if (batch.items.length > 0) {
      const first = batch.items[0];
      void onSend(formatBatch(first.from_bot, batch.items), batch.items);
    }
    _recent.delete(key);
  }
}

module.exports = { processItem, flushAll };
