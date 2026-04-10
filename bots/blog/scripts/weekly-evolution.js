#!/usr/bin/env node
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

try {
  require(path.join(env.PROJECT_ROOT, 'bots/blog/scripts/weekly-evolution.ts'));
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    throw error;
  }
  require(path.join(env.PROJECT_ROOT, 'bots/blog/scripts/weekly-evolution.ts'));
}
