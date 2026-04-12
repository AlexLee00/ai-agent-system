'use strict';

const path = require('path');
const distPath = path.join(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/pickko-member-service.js');

try {
  module.exports = require(distPath);
} catch (_error) {
  module.exports = require('./pickko-member-service.legacy.js');
}
