'use strict';

const path = require('path');

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/blog/scripts/post-comment-test.js',
);

module.exports = require(runtimePath);
