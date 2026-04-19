'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'guardian');
module.exports.default = module.exports;
