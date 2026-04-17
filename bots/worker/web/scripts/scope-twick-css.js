'use strict';

const path = require('path');
const { loadSiblingTsSource } = require('../ts-source-bridge.js');

const runtimePath = path.join(
  __dirname,
  '../../../../dist/ts-runtime/bots/worker/web/scripts/scope-twick-css.js'
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  module.exports = loadSiblingTsSource(__dirname, 'scope-twick-css');
}
