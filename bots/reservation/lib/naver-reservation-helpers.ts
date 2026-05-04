import { buildReservationCompositeKey } from './reservation-key';

export type ReservationLike = Record<string, any>;

export function isTerminalReservationLike(reservation: ReservationLike | null | undefined): boolean {
  if (!reservation) return false;
  return Boolean(
    reservation.status === 'completed'
    || reservation.status === 'cancelled'
    || reservation.markedSeen
    || reservation.seenOnly
    || ['manual', 'manual_retry', 'manual_pending', 'verified', 'time_elapsed', 'cancelled'].includes(reservation.pickkoStatus),
  );
}

export function getAlertLevelByType(type: string): number {
  if (type === 'error') return 3;
  if (type === 'new') return 2;
  return 1;
}

export function buildMonitoringTrackingKey(booking: ReservationLike): string {
  return (
    booking.bookingId
    || buildReservationCompositeKey(booking.phoneRaw || booking.phone, booking.date, booking.start, booking.end, booking.room)
  );
}

export function buildSlotCompositeKey(booking: ReservationLike): string {
  return buildReservationCompositeKey(booking.phoneRaw || booking.phone, booking.date, booking.start, booking.end, booking.room);
}

export function fillMissingBookingDate(
  booking: ReservationLike,
  todaySeoul = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
): ReservationLike {
  return { ...booking, date: booking.date || todaySeoul };
}

export function buildConfirmedListKey(booking: ReservationLike, todaySeoul: string): string {
  return booking.bookingId || `${booking.date || todaySeoul}|${booking.start}|${booking.end}|${booking.room}|${booking.phone}`;
}

export function buildCancelKey(booking: ReservationLike, todaySeoul: string): string {
  const bookingId = booking.bookingId;
  if (bookingId && /^\d+$/.test(String(bookingId))) return `cancelid|${bookingId}`;
  return `cancel|${booking.date || todaySeoul}|${booking.start}|${booking.end}|${booking.room}|${booking.phoneRaw || String(booking.phone || '').replace(/\D/g, '')}`;
}
