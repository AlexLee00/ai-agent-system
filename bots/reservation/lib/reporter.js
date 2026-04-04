'use strict';

const { sendTelegram, flushPendingTelegrams } = require('./telegram');

module.exports = {
  sendTelegram,
  flushPendingTelegrams,
};
