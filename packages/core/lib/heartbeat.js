'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/heartbeat.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM')) {
    module.exports = require('./heartbeat.legacy.js');
  } else {
    throw error;
  }
}
