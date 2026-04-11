'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/naver-alert-helpers.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./naver-alert-helpers.legacy.js');
}
