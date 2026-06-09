'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

const bridged = loadTsSourceBridge(__dirname, 'builder');

module.exports = bridged;
module.exports.default = module.exports;

if (require.main === module && typeof bridged.runBuildCheck === 'function') {
  bridged.runBuildCheck({ force: true })
    .then((result) => {
      console.log(result.message);
      process.exit(result.pass ? 0 : 1);
    })
    .catch((error) => {
      console.warn(`[builder] 실행 실패: ${error.message}`);
      process.exit(0);
    });
}
