'use strict';

const path = require('path');
const distPath = path.join(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/pickko-room-slot-service.js');

try {
  module.exports = require(distPath);
} catch (_error) {
  module.exports = require('./pickko-room-slot-service.legacy.js');
}
