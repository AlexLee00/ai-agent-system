// @ts-nocheck
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createPickkoMemberService } = require('../lib/pickko-member-service.ts');

async function main() {
  let submitAttempted = false;
  const page = {
    goto: async () => {},
    $: async (selector) => (selector === '#mb_phone3' ? null : {
      click: async () => {},
      type: async () => {},
    }),
    evaluate: async () => { submitAttempted = true; return true; },
  };
  const service = createPickkoMemberService({
    delay: async () => {},
    log: () => {},
    maskName: (value) => value,
    maskPhone: (value) => value,
    publishReservationAlert: async () => {},
  });
  await assert.rejects(
    service.registerNewMember(page, '01000000000', '테스트', '2026-07-24'),
    /PICKKO_MEMBER_FORM_INVALID:mb_phone3/,
  );
  assert.equal(submitAttempted, false, 'missing required controls must block all evaluate/submit work');

  const control = {
    click: async () => {},
    type: async () => {},
  };
  let evaluateCall = 0;
  const missingFormPage = {
    goto: async () => {},
    $: async () => control,
    evaluate: async () => {
      evaluateCall += 1;
      return evaluateCall === 1;
    },
    waitForNavigation: async () => null,
  };
  await assert.rejects(
    service.registerNewMember(missingFormPage, '01000000000', '테스트', '2026-07-24'),
    /PICKKO_MEMBER_FORM_INVALID:memberFrom/,
  );

  const source = fs.readFileSync(path.join(__dirname, '../lib/pickko-member-service.ts'), 'utf8');
  assert.doesNotMatch(source, /form#memberFrom, form/);
  assert.match(source, /form#memberFrom/);
  console.log('pickko_member_form_contract_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
