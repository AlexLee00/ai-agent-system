export function normalizePhoneRaw(value: unknown): string {
  return String(value || '').replace(/\D/g, '');
}

export function buildReservationId(phoneRaw: unknown, date: string, start: string): string {
  const phone = normalizePhoneRaw(phoneRaw);
  return `${phone}-${date}-${start}`;
}

export function buildReservationCompositeKey(
  phoneRaw: unknown,
  date: string,
  start: string,
  end: string,
  room: string,
): string {
  const phone = normalizePhoneRaw(phoneRaw);
  return `${date}|${start}|${end}|${room}|${phone}`;
}
