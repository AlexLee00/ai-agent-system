'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/event-lake.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./event-lake.legacy.js');
}
