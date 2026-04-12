'use strict';

const path = require('node:path');
const { loadTsModule } = require('./ts-fallback-loader.legacy.js');

module.exports = loadTsModule(path.join(__dirname, 'pickko-member-service.ts'));
