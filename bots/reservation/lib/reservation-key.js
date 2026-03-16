'use strict';

function normalizePhoneRaw(value) {
  return String(value || '').replace(/\D/g, '');
}

function buildReservationId(phoneRaw, date, start) {
  const phone = normalizePhoneRaw(phoneRaw);
  return `${phone}-${date}-${start}`;
}

function buildReservationCompositeKey(phoneRaw, date, start, end, room) {
  const phone = normalizePhoneRaw(phoneRaw);
  return `${date}|${start}|${end}|${room}|${phone}`;
}

module.exports = {
  normalizePhoneRaw,
  buildReservationId,
  buildReservationCompositeKey,
};
