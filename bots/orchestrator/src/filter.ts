const { isAlertMuted, isEventMuted } = require('../lib/mute-manager') as {
  isAlertMuted: (fromBot: string, team: string | null) => Promise<boolean>;
  isEventMuted: (fromBot: string, eventType: string | null) => Promise<boolean>;
};
const { shouldDefer, deferToMorning } = require('../lib/night-handler') as {
  shouldDefer: (alertLevel: number) => boolean;
  deferToMorning: (id: string | number, headline: string, bots: string[]) => Promise<void>;
};
const { formatBatch, buildSingleDelivery } = require('../lib/batch-formatter') as {
  formatBatch: (fromBot: string, items: QueueItem[]) => string;
  buildSingleDelivery: (item: QueueItem) => string;
};
const { getEventHeadline } = require('../../../packages/core/lib/reporting-hub') as {
  getEventHeadline: (item: QueueItem) => string;
};

type QueueItem = {
  id: string | number;
  from_bot: string;
  team?: string | null;
  event_type?: string | null;
  alert_level: number;
};

type BatchState = {
  items: QueueItem[];
  timer: NodeJS.Timeout;
};

type SendCallback = (message: string, payload: QueueItem | QueueItem[]) => Promise<boolean> | boolean;

const DEDUP_WINDOW_MS = 60_000;
const recent = new Map<string, BatchState>();

function buildBatchKey(item: QueueItem): string {
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

export async function processItem(item: QueueItem, onSend: SendCallback): Promise<'sent' | 'muted' | 'deferred' | 'batched' | 'error'> {
  if (await isAlertMuted(item.from_bot, item.team || null)) {
    return 'muted';
  }

  if (await isEventMuted(item.from_bot, item.event_type || null)) {
    return 'muted';
  }

  if (shouldDefer(item.alert_level)) {
    await deferToMorning(item.id, getEventHeadline(item).slice(0, 60), [item.from_bot]);
    return 'deferred';
  }

  if (item.alert_level <= 2) {
    const key = buildBatchKey(item);
    const existing = recent.get(key);
    if (existing) {
      existing.items.push(item);
      return 'batched';
    }

    const batch: BatchState = {
      items: [item],
      timer: setTimeout(() => {
        recent.delete(key);
        const message = formatBatch(item.from_bot, batch.items);
        void onSend(message, batch.items);
      }, DEDUP_WINDOW_MS),
    };

    recent.set(key, batch);
    return 'batched';
  }

  const delivery = buildSingleDelivery(item);
  const ok = await onSend(delivery, item);
  return ok ? 'sent' : 'error';
}

export function flushAll(onSend: SendCallback): void {
  for (const [key, batch] of recent.entries()) {
    clearTimeout(batch.timer);
    if (batch.items.length > 0) {
      const first = batch.items[0];
      const message = formatBatch(first.from_bot, batch.items);
      void onSend(message, batch.items);
    }
    recent.delete(key);
  }
}
