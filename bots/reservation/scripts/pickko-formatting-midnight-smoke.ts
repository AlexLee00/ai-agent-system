// @ts-nocheck
'use strict';

const assert = require('assert');
const { pickkoEndTime } = require('../lib/formatting.ts');

assert.equal(pickkoEndTime('11:00'), '10:50');
assert.equal(
  pickkoEndTime('00:00'),
  '23:50',
  'a midnight boundary must wrap to the previous day instead of producing a negative clock',
);

console.log('pickko_formatting_midnight_smoke_ok');
