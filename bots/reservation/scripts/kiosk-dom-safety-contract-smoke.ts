// @ts-nocheck
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { canSaveKioskPanel } = require('../lib/kiosk-panel-service.ts');

function main() {
  assert.equal(canSaveKioskPanel({ popupVisible: true, startSet: true, endSet: true, statusSet: true }), true);
  for (const missing of ['popupVisible', 'startSet', 'endSet', 'statusSet']) {
    const state = { popupVisible: true, startSet: true, endSet: true, statusSet: true };
    state[missing] = false;
    assert.equal(canSaveKioskPanel(state), false, `${missing}=false must block save`);
  }

  const slotSource = fs.readFileSync(path.join(__dirname, '../lib/kiosk-slot-calendar-service.ts'), 'utf8');
  assert.equal(slotSource.includes('fallback_next_slot'), false, 'room blocking must not shift to a later start slot');
  assert.match(slotSource, /exact_start_slot_unavailable/);

  console.log('kiosk_dom_safety_contract_smoke_ok');
}

main();
