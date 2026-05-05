'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

const bridged = loadTsSourceBridge(__dirname, 'claude-commander');

module.exports = bridged;
module.exports.default = bridged;

if (require.main === module && typeof bridged?.main === 'function') {
  bridged.main().catch((e) => {
    console.error(`[클로드] 치명적 오류:`, e);
    process.exit(1);
  });
}
