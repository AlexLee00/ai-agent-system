'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/report-followup-helpers.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./report-followup-helpers.legacy.js');
}
