'use strict';

const path = require('path');

const sourcePath = path.join(__dirname, 'run-neighbor-sympathy.ts');
const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/blog/scripts/run-neighbor-sympathy.js',
);

try {
  module.exports = require(sourcePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  module.exports = require(runtimePath);
}
