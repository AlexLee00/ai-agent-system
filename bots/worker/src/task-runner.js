'use strict';

const path = require('node:path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/worker/src/task-runner.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM')) {
    module.exports = require('./task-runner.legacy.js');
  } else {
    throw error;
  }
}
