'use strict';

const path = require('node:path');
const { loadTsModule } = require('../lib/ts-fallback-loader.legacy.js');

module.exports = loadTsModule(path.join(__dirname, '002_daily_summary_columns.ts'));
