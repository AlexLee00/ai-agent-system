'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/hub/scripts/telegram-callback-poller.js');

try {
  require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM')) {
    require('./telegram-callback-poller.legacy.js');
  } else {
    throw error;
  }
}
