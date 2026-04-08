const telegramSenderModule =
  require('./telegram-sender.js') as typeof import('./telegram-sender.js');

export const {
  send,
  sendCritical,
  flushPending,
  _normalizeForMobile,
} = telegramSenderModule;
