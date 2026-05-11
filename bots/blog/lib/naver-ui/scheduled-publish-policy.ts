// @ts-nocheck
'use strict';

function kstDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function kstDateString(date = new Date()) {
  const parts = kstDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addDaysToKstDate(date = new Date(), days = 0, hour = 7, minute = 0) {
  const parts = kstDateParts(date);
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0), Number(hour || 0) - 9, Number(minute || 0), 0));
  return utc;
}

function resolveSafeScheduledAt(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const minDays = Math.max(5, Number(options.minDays || 5));
  const hour = Number.isFinite(Number(options.hour)) ? Number(options.hour) : 7;
  const minute = Number.isFinite(Number(options.minute)) ? Number(options.minute) : 0;
  const requested = options.requestedAt ? new Date(options.requestedAt) : null;
  const minimum = addDaysToKstDate(now, minDays, hour, minute);
  if (requested && requested.getTime() >= minimum.getTime()) return requested;
  return minimum;
}

function assertSafeScheduledAt(scheduledAt, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const minDays = Math.max(5, Number(options.minDays || 5));
  const minimum = addDaysToKstDate(now, minDays, 0, 0);
  const target = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(target.getTime())) {
    const error = new Error('invalid_schedule_date');
    error.code = 'invalid_schedule_date';
    throw error;
  }
  if (target.getTime() < minimum.getTime()) {
    const error = new Error('schedule_date_too_soon');
    error.code = 'schedule_date_too_soon';
    error.details = {
      scheduledAt: target.toISOString(),
      minimum: minimum.toISOString(),
      minDays,
    };
    throw error;
  }
  return true;
}

function formatKstScheduleFields(scheduledAt) {
  const parts = kstDateParts(scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt));
  return {
    date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    year: String(parts.year),
    month: String(parts.month).padStart(2, '0'),
    day: String(parts.day).padStart(2, '0'),
    hour: String(parts.hour).padStart(2, '0'),
    minute: String(parts.minute).padStart(2, '0'),
  };
}

module.exports = {
  kstDateParts,
  kstDateString,
  addDaysToKstDate,
  resolveSafeScheduledAt,
  assertSafeScheduledAt,
  formatKstScheduleFields,
};
