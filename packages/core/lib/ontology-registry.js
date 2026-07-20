'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge');

module.exports = loadTsSourceBridge(__dirname, 'ontology-registry');
module.exports.default = module.exports;
