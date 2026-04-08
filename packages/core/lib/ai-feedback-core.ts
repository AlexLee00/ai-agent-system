type FeedbackEventType =
  | 'proposal_generated'
  | 'review_opened'
  | 'field_edited'
  | 'field_added'
  | 'field_removed'
  | 'confirmed'
  | 'rejected'
  | 'submitted'
  | 'committed'
  | 'abandoned';

type FeedbackStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'submitted'
  | 'committed'
  | 'abandoned';

type FeedbackDiffEvent = {
  eventType: FeedbackEventType;
  fieldKey?: string;
  beforeValue?: unknown;
  afterValue?: unknown;
};

type FeedbackEventLike = {
  eventType?: string;
  event_type?: string;
};

const FEEDBACK_EVENT_TYPES = Object.freeze({
  PROPOSAL_GENERATED: 'proposal_generated',
  REVIEW_OPENED: 'review_opened',
  FIELD_EDITED: 'field_edited',
  FIELD_ADDED: 'field_added',
  FIELD_REMOVED: 'field_removed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SUBMITTED: 'submitted',
  COMMITTED: 'committed',
  ABANDONED: 'abandoned',
} as const);

const FEEDBACK_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SUBMITTED: 'submitted',
  COMMITTED: 'committed',
  ABANDONED: 'abandoned',
} as const);

const SECRET_KEYS = [
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'api_key',
  'authorization',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeFeedbackValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeFeedbackValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.some((secretKey) => lowered.includes(secretKey))) {
      continue;
    }
    next[key] = sanitizeFeedbackValue(rawValue);
  }
  return next;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function buildFieldDiffEvents(originalSnapshot: unknown, updatedSnapshot: unknown): FeedbackDiffEvent[] {
  const original = sanitizeFeedbackValue(originalSnapshot || {}) as Record<string, unknown>;
  const updated = sanitizeFeedbackValue(updatedSnapshot || {}) as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(isPlainObject(original) ? original : {}),
    ...Object.keys(isPlainObject(updated) ? updated : {}),
  ]);

  const events: FeedbackDiffEvent[] = [];
  for (const key of keys) {
    const beforeValue = original[key];
    const afterValue = updated[key];
    const hasBefore = Object.prototype.hasOwnProperty.call(original, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(updated, key);

    if (hasBefore && !hasAfter) {
      events.push({
        eventType: FEEDBACK_EVENT_TYPES.FIELD_REMOVED,
        fieldKey: key,
        beforeValue,
        afterValue: null,
      });
      continue;
    }
    if (!hasBefore && hasAfter) {
      events.push({
        eventType: FEEDBACK_EVENT_TYPES.FIELD_ADDED,
        fieldKey: key,
        beforeValue: null,
        afterValue,
      });
      continue;
    }
    if (!valuesEqual(beforeValue, afterValue)) {
      events.push({
        eventType: FEEDBACK_EVENT_TYPES.FIELD_EDITED,
        fieldKey: key,
        beforeValue,
        afterValue,
      });
    }
  }

  return events;
}

function isEditEvent(eventType: string | undefined): boolean {
  return eventType === FEEDBACK_EVENT_TYPES.FIELD_EDITED
    || eventType === FEEDBACK_EVENT_TYPES.FIELD_ADDED
    || eventType === FEEDBACK_EVENT_TYPES.FIELD_REMOVED;
}

function hasEditEvents(events: FeedbackEventLike[] = []): boolean {
  return events.some((event) => isEditEvent(event.eventType || event.event_type));
}

function shouldMarkAcceptedWithoutEdit(status: string, events: FeedbackEventLike[] = []): boolean {
  if (status !== FEEDBACK_STATUSES.CONFIRMED && status !== FEEDBACK_STATUSES.COMMITTED) {
    return false;
  }
  return !hasEditEvents(events);
}

export = {
  FEEDBACK_EVENT_TYPES,
  FEEDBACK_STATUSES,
  sanitizeFeedbackValue,
  buildFieldDiffEvents,
  hasEditEvents,
  shouldMarkAcceptedWithoutEdit,
};
