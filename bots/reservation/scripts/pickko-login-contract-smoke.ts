// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { loginToPickko } = require('../lib/pickko.ts');

function createPage({ formResult, postState, url }) {
  let functionCalls = 0;
  return {
    __reservationEvalShimInstalled: true,
    goto: async () => {},
    url: () => url,
    waitForNavigation: async () => null,
    waitForFunction: async () => null,
    evaluate: async (input) => {
      if (typeof input === 'string') return null;
      functionCalls += 1;
      return functionCalls === 1 ? formResult : postState;
    },
  };
}

async function main() {
  await assert.rejects(
    loginToPickko(createPage({
      formResult: { submitted: false, missing: ['mn_pw'] },
      postState: { loginFormPresent: true, authenticatedMarker: false },
      url: 'https://pickkoadmin.com/manager/login.html',
    }), 'id', 'pw', async () => {}),
    /PICKKO_LOGIN_FORM_INVALID/,
  );

  await assert.rejects(
    loginToPickko(createPage({
      formResult: { submitted: true, missing: [] },
      postState: { loginFormPresent: true, authenticatedMarker: false },
      url: 'https://pickkoadmin.com/manager/login.html',
    }), 'id', 'pw', async () => {}),
    /PICKKO_LOGIN_FAILED/,
  );

  await loginToPickko(createPage({
    formResult: { submitted: true, missing: [] },
    postState: { loginFormPresent: false, authenticatedMarker: true },
    url: 'https://pickkoadmin.com/manager/index.html',
  }), 'id', 'pw', async () => {});

  console.log('pickko_login_contract_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
