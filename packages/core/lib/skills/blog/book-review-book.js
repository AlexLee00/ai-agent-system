'use strict';

const { loadTsSourceBridge } = require('../../ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'skills/blog/book-review-book');
module.exports.default = module.exports;
