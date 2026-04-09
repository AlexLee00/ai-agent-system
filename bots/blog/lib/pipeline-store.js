const path = require('path');

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/blog/lib/pipeline-store.js'
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  module.exports = require('./pipeline-store.legacy.js');
}
