#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { buildRetiredFeatureResult } = require('../lib/retirement-policy.ts');

const feature = process.argv.find((arg) => arg.startsWith('--feature='))?.slice('--feature='.length)
  || 'blog-feature';
console.log(JSON.stringify(buildRetiredFeatureResult(feature), null, 2));
