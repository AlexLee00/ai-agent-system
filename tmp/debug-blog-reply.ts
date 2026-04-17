import puppeteer from 'puppeteer';

const WS = 'ws://127.0.0.1:62411/devtools/browser/1dd2e74e-c991-433f-b225-769931b73eb7';
const POST_URL = 'https://blog.naver.com/cafe_library/224249895818';
const LOG_NO = '224249895818';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const browser = await puppeteer.connect({
    browserWSEndpoint: WS,
    protocolTimeout: 60000,
  });

  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(30000);

  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

  for (let i = 0; i < 10; i += 1) {
    const frame = page.frames().find((item) => item.name() === 'mainFrame' || /PostView\.naver/.test(item.url()));
    console.log('frame-attempt', i, frame ? frame.url() : 'none');
    if (!frame) {
      await sleep(800);
      continue;
    }

    await frame.waitForSelector('body', { timeout: 15000 }).catch(() => {});
    await sleep(5000);

    const before = await frame.evaluate((logNo) => {
      const visible = (el: Element | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el as Element);
        const rect = (el as Element).getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const root = document.querySelector(`#naverComment_201_${logNo}_ct`);
      const list = document.querySelector(`#naverComment_201_${logNo}`);
      const btn = document.querySelector(`#Comi${logNo}`) || document.querySelector('#btn_comment_2');
      return {
        href: location.href,
        root: !!root,
        rootVisible: visible(root),
        list: !!list,
        listVisible: visible(list),
        btn: !!btn,
        btnVisible: visible(btn),
      };
    }, LOG_NO);

    console.log('before', JSON.stringify(before));

    const clicked = await frame.evaluate((logNo) => {
      const btn = document.querySelector(`#Comi${logNo}`) || document.querySelector('#btn_comment_2');
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      (btn as HTMLElement).click();
      const rect = (btn as Element).getBoundingClientRect();
      const ev = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      btn.dispatchEvent(new MouseEvent('pointerdown', ev));
      btn.dispatchEvent(new MouseEvent('mousedown', ev));
      btn.dispatchEvent(new MouseEvent('pointerup', ev));
      btn.dispatchEvent(new MouseEvent('mouseup', ev));
      btn.dispatchEvent(new MouseEvent('click', ev));
      return true;
    }, LOG_NO).catch(() => false);

    console.log('clicked', clicked);
    await sleep(5000);

    const after = await frame.evaluate((logNo) => {
      const textOf = (el: Element | null) =>
        String((el && ((el as HTMLElement).innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
      const visible = (el: Element | null) => {
        if (!el) return false;
        const style = window.getComputedStyle(el as Element);
        const rect = (el as Element).getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const root = document.querySelector(`#naverComment_201_${logNo}_ct`);
      const list = document.querySelector(`#naverComment_201_${logNo}`);
      const write = document.querySelector('.commentbox_header .btn_write_comment._naverCommentWriteBtn, .commentbox_header .btn_write_comment');
      const replyButtons = Array.from(document.querySelectorAll('button,a'))
        .filter((btn) => visible(btn))
        .filter((btn) => {
          const text = textOf(btn);
          const cls = String((btn as HTMLElement).className || '');
          return (/답글|답변/.test(text) || /btn_reply|reply/i.test(cls)) && !/widget_recent_reply/i.test(cls);
        })
        .slice(0, 10)
        .map((btn) => ({
          text: textOf(btn),
          cls: String((btn as HTMLElement).className || '').slice(0, 160),
        }));

      return {
        href: location.href,
        rootVisible: visible(root),
        listVisible: visible(list),
        writeVisible: visible(write),
        listText: textOf(list).slice(0, 500),
        replyButtons,
      };
    }, LOG_NO);

    console.log('after', JSON.stringify(after));
    break;
  }

  await page.close();
  await browser.disconnect();
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
