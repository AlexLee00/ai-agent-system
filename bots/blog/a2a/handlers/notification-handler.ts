import type { A2ANotification } from '../types.ts';

type NotifListener = (n: A2ANotification) => void;
const _listeners: NotifListener[] = [];

export function onNotification(listener: NotifListener): void {
  _listeners.push(listener);
}

export function handleNotification(notif: A2ANotification): void {
  for (const listener of _listeners) {
    try { listener(notif); } catch (_) { /* 무시 */ }
  }
}
