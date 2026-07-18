'use strict';

const { loadTsSourceBridge } = require('../../../packages/core/lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'implementor');
module.exports.default = module.exports;
