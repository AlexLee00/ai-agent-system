'use strict';

const { sendTelegram, tryTelegramSend, flushPendingTelegrams } = require('./telegram');

module.exports = {
  sendTelegram,
  tryTelegramSend,
  flushPendingTelegrams,
};
