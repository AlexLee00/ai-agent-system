'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'claude-commander');
module.exports.default = module.exports;
