import type { A2AMessage, A2AMessageResult } from '../types.ts';

type MessageListener = (msg: A2AMessage) => void;
const _listeners: MessageListener[] = [];

export function onMessage(listener: MessageListener): void {
  _listeners.push(listener);
}

export function handleMessage(msg: A2AMessage): A2AMessageResult {
  for (const listener of _listeners) {
    try { listener(msg); } catch (_) { /* 리스너 실패 무시 */ }
  }
  return { id: msg.id, status: 'received' };
}
