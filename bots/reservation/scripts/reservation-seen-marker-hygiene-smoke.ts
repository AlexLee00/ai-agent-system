#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../lib/db.ts'), 'utf8');
const markSeenBlock = source.match(/async function markSeen\(id\) \{[\s\S]*?\n\}/)?.[0] || '';

assert.match(markSeenBlock, /VALUES\(\$1,NULL,NULL,1\)/, 'seen marker must use NULL date/start_time');
assert.doesNotMatch(markSeenBlock, /\[id,\s*['"]{2},\s*['"]{2}\]/, 'seen marker must not persist blank date/start_time');

console.log('reservation_seen_marker_hygiene_smoke_ok');
