'use strict';

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
});

const FEEDBACK_STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  SUBMITTED: 'submitted',
  COMMITTED: 'committed',
  ABANDONED: 'abandoned',
});

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

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeFeedbackValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeFeedbackValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const next = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.some(secretKey => lowered.includes(secretKey))) {
      continue;
    }
    next[key] = sanitizeFeedbackValue(rawValue);
  }
  return next;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    return JSON.stringify(value);
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function valuesEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function buildFieldDiffEvents(originalSnapshot, updatedSnapshot) {
  const original = sanitizeFeedbackValue(originalSnapshot || {});
  const updated = sanitizeFeedbackValue(updatedSnapshot || {});
  const keys = new Set([
    ...Object.keys(isPlainObject(original) ? original : {}),
    ...Object.keys(isPlainObject(updated) ? updated : {}),
  ]);

  const events = [];
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

function isEditEvent(eventType) {
  return [
    FEEDBACK_EVENT_TYPES.FIELD_EDITED,
    FEEDBACK_EVENT_TYPES.FIELD_ADDED,
    FEEDBACK_EVENT_TYPES.FIELD_REMOVED,
  ].includes(eventType);
}

function hasEditEvents(events = []) {
  return events.some(event => isEditEvent(event.eventType || event.event_type));
}

function shouldMarkAcceptedWithoutEdit(status, events = []) {
  if (![FEEDBACK_STATUSES.CONFIRMED, FEEDBACK_STATUSES.COMMITTED].includes(status)) {
    return false;
  }
  return !hasEditEvents(events);
}

module.exports = {
  FEEDBACK_EVENT_TYPES,
  FEEDBACK_STATUSES,
  sanitizeFeedbackValue,
  buildFieldDiffEvents,
  hasEditEvents,
  shouldMarkAcceptedWithoutEdit,
};
