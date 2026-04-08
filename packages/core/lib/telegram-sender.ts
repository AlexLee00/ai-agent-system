const telegramSenderModule = require('./telegram-sender.js');

export const send = telegramSenderModule.send;
export const sendCritical = telegramSenderModule.sendCritical;
export const flushPending = telegramSenderModule.flushPending;
export const _normalizeForMobile = telegramSenderModule._normalizeForMobile;
