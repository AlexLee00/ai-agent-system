'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/message-envelope.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./message-envelope.legacy.js');
}
