// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { createNaverBrowserSessionService } = require('../lib/naver-browser-session-service.ts');

async function main() {
  let closeCount = 0;
  const browser = {
    wsEndpoint: () => 'ws://127.0.0.1/devtools/browser/test',
    close: async () => { closeCount += 1; },
  };
  const service = createNaverBrowserSessionService({
    log: () => {},
    launchPuppeteer: async () => browser,
    getNaverLaunchOptions: () => ({}),
    waitForWsEndpointFromActivePort: async () => null,
    waitForDevtoolsEndpoint: async () => false,
    delay: async () => {},
    writeFileSync: () => {},
    unlinkSync: () => {},
    pathJoin: (...parts) => parts.join('/'),
    isHeadedMode: () => false,
    naverLogin: async () => false,
  });

  await assert.rejects(
    service.startBrowserSession({
      workspace: '/tmp/test',
      modeSuffix: '',
      naverUrl: 'https://example.test',
      naverWsFile: '/tmp/test/ws',
      naverUserDataDir: '/tmp/test/profile',
    }),
    /DevTools endpoint unavailable/,
  );
  assert.equal(closeCount, 1, 'browser must close when session initialization fails');
  console.log('naver_browser_session_cleanup_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
