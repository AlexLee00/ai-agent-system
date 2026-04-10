'use strict';

const path = require('path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/reservation/scripts/manual-batch-reserve.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  module.exports = require('./manual-batch-reserve.legacy.js');
}
