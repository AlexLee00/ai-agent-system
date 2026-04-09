'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../../dist/ts-runtime/bots/hub/lib/routes/n8n.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM')) {
    module.exports = require('./n8n.legacy.js');
  } else {
    throw error;
  }
}
