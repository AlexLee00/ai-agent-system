'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../../dist/ts-runtime/bots/hub/lib/routes/events.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM')) {
    module.exports = require('./events.legacy.js');
  } else {
    throw error;
  }
}
