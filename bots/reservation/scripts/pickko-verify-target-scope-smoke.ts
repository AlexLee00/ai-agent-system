'use strict';

const assert = require('assert');
const { needsVerify } = require('../manual/admin/pickko-verify.ts');

assert.strictEqual(needsVerify({ status: 'pending' }), false, 'pending must stay owned by naver-monitor');
assert.strictEqual(needsVerify({ status: 'processing' }), false, 'processing must stay owned by naver-monitor');
assert.strictEqual(needsVerify({ status: 'failed' }), false, 'failed retry must stay owned by naver-monitor');
assert.strictEqual(needsVerify({ status: 'cancelled' }), false);

assert.strictEqual(needsVerify({ status: 'completed', pickkoStatus: null }), true);
assert.strictEqual(needsVerify({ status: 'completed', pickkoStatus: 'paid' }), true);
assert.strictEqual(needsVerify({ status: 'completed', pickkoStatus: 'verified' }), false);
assert.strictEqual(needsVerify({ status: 'completed', pickkoStatus: 'manual' }), false);

console.log('✅ pickko verify target scope smoke ok');
