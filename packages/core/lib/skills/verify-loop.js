'use strict';

const { loadTsSourceBridge } = require('../ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'verify-loop');
module.exports.default = module.exports;
