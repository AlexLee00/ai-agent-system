'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/telegram-sender.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./telegram-sender.legacy.js');
}
