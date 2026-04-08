'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/kst.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./kst.legacy.js');
}
