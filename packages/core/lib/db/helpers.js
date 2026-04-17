'use strict';

const { loadTsSourceBridge } = require('../ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'helpers');
module.exports.default = module.exports;
