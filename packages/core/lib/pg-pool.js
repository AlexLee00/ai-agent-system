'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/pg-pool.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./pg-pool.legacy.js');
}
