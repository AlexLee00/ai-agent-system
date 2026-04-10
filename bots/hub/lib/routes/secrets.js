'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../../dist/ts-runtime/bots/hub/lib/routes/secrets.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
    module.exports = require('./secrets.legacy.js');
  } else {
    throw error;
  }
}
