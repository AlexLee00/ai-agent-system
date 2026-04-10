'use strict';

const path = require('path');
const sourcePath = path.join(__dirname, 'run-commenter.ts');

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/blog/scripts/run-commenter.js',
);

try {
  module.exports = require(sourcePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  try {
    module.exports = require(runtimePath);
  } catch (runtimeError) {
    if (runtimeError && runtimeError.code !== 'MODULE_NOT_FOUND') {
      throw runtimeError;
    }
    module.exports = require('./run-commenter.legacy.js');
  }
}
