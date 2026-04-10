'use strict';

const path = require('path');

const runtimePath = path.join(
  __dirname,
  '../dist/ts-runtime/scripts/session-close.js'
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  module.exports = require('./session-close.legacy.js');
}
