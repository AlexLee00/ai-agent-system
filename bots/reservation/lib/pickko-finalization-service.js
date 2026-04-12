try {
  module.exports = require('../../../../dist/ts-runtime/bots/reservation/lib/pickko-finalization-service.js');
} catch (_) {
  module.exports = require('./pickko-finalization-service.legacy.js');
}
