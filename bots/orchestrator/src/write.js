'use strict';

const { loadTsSourceBridge } = require('../../../packages/core/lib/ts-source-bridge.js');

const mod = loadTsSourceBridge(__dirname, 'write');

module.exports = mod;
module.exports.default = mod;

if (require.main === module) {
  const argv = process.argv.slice(2);
  const modeArg = argv.find((arg) => String(arg).startsWith('--mode='));
  const mode = modeArg ? String(modeArg).split('=')[1] : 'push';
  const options = {
    mode,
    test: argv.includes('--test'),
  };
  const runner = mode === 'daily' ? mod.runDaily : mod.runOnPush;
  Promise.resolve(runner(options))
    .then((result) => {
      console.log(result?.message || '');
      process.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[write] 실행 실패: ${message}`);
      process.exit(0);
    });
}
