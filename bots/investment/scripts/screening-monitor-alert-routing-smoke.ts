#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { classifyScreeningAlertRoute } from './screening-monitor.ts';

const overseasGap = classifyScreeningAlertRoute(
  'overseas',
  'overseas_quote_or_liquidity_filtered_all: candidates=45, quoteUniverse=30, quoteMap=0',
);
assert.equal(overseasGap.visibility, 'digest');
assert.equal(overseasGap.alarm_type, 'report');
assert.equal(overseasGap.actionability, 'none');
assert.match(overseasGap.incident_key, /screening_source_gap:overseas$/);

const domesticFailure = classifyScreeningAlertRoute(
  'domestic',
  'core_collect_failure_rate_high',
);
assert.equal(domesticFailure.visibility, 'notify');
assert.equal(domesticFailure.alarm_type, 'error');
assert.equal(domesticFailure.actionability, 'auto_repair');
assert.match(domesticFailure.incident_key, /screening_failure:domestic$/);

console.log('screening monitor alert routing smoke ok');
