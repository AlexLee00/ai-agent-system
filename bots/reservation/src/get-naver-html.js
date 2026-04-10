'use strict';

const path = require('path');

const runtimePath = path.join(__dirname, '../../../dist/ts-runtime/bots/reservation/src/get-naver-html.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  module.exports = require('./get-naver-html.legacy.js');
}
