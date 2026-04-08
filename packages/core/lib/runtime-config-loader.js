'use strict';

const path = require('node:path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/runtime-config-loader.js');

try {
  module.exports = require(distPath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  module.exports = require('./runtime-config-loader.legacy.js');
}
