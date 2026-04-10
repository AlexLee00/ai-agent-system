'use strict';

const path = require('path');

const runtimePath = path.join(
  __dirname,
  '../dist/ts-runtime/scripts/seed-rag-system-docs.js'
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  module.exports = require('./seed-rag-system-docs.legacy.js');
}
