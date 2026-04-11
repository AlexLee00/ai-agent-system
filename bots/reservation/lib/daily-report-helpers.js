'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/daily-report-helpers.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./daily-report-helpers.legacy.js');
}
