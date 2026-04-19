'use strict';

const env = require('./env.js');

module.exports = {
  MODE: env.MODE,
  ensureOps: env.ensureOps,
  ensureDev: env.ensureDev,
  isOps: () => env.IS_OPS,
  isDev: () => env.IS_DEV,
  getMode: () => env.MODE,
  runIfOps: env.runIfOps,
};
