const puppeteer = require('puppeteer');

function getPickkoLaunchOptions() {
  return {
    headless: false,
    defaultViewport: null,
    protocolTimeout: parseInt(process.env.PICKKO_PROTOCOL_TIMEOUT_MS || '180000', 10),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-position=0,25', '--window-size=2294,1380']
  };
}

function setupDialogHandler(page, log) {
  page.on('dialog', async d => {
    try {
      log?.(`🧾 팝업 감지: ${d.message()}`);
      await d.accept();
      log?.('✅ 팝업 확인');
    } catch (e) { log?.(`⚠️ 팝업 처리 실패: ${e.message}`); }
  });
}

module.exports = { getPickkoLaunchOptions, setupDialogHandler };
