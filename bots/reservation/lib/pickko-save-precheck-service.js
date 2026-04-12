try {
  module.exports = require('../../../../dist/ts-runtime/bots/reservation/lib/pickko-save-precheck-service.js');
} catch (_) {
  module.exports = require('./pickko-save-precheck-service.legacy.js');
}
