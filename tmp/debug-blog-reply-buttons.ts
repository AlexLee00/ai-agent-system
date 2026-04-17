const fs = require('fs');
const puppeteer = require('puppeteer');

const POST_URL = 'https://blog.naver.com/cafe_library/224184872044';
const LOG_NO = '224184872044';
const COMMENT_NO = '890530107813265623';
const COMMENTER = '마이라이프';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const ws = String(fs.readFileSync('/Users/alexlee/.openclaw/workspace/naver-monitor-ws.txt', 'utf8') || '').trim();
  if (!ws) throw new Error('ws_not_found');

  const browser = await puppeteer.connect({ browserWSEndpoint: ws, protocolTimeout: 120000 });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(45000);
  page.setDefaultTimeout(30000);

  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(1500);

  const frame = page.frames().find((item) => item.name() === 'mainFrame' || /PostView\.naver/.test(item.url())) || page.mainFrame();

  const info = await frame.evaluate(`
    (() => {
      const logNo = ${JSON.stringify(LOG_NO)};
      const targetCommentNo = ${JSON.stringify(COMMENT_NO)};
      const commenter = ${JSON.stringify(COMMENTER)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();

      const toggle = document.querySelector('#Comi' + logNo) || document.querySelector('#btn_comment_2');
      if (toggle) {
        toggle.scrollIntoView({ block: 'center', behavior: 'instant' });
        toggle.click();
      }

      const root = document.querySelector('#naverComment_201_' + logNo + '_ct');
      if (root && root instanceof HTMLElement) {
        root.style.display = 'block';
        root.style.visibility = 'visible';
      }

      const replyButtons = Array.from(document.querySelectorAll('button, a'))
        .filter(visible)
        .filter((node) => text(node).includes('답글'))
        .map((node) => ({
          text: text(node),
          className: String(node.className || ''),
          matchesTarget: String(node.className || '').includes('idx-commentNo-' + targetCommentNo),
        }));

      const commentBlocks = Array.from(document.querySelectorAll('li.u_cbox_comment, div.u_cbox_comment_box, li[class*="comment"]'))
        .filter(visible)
        .map((node) => text(node).slice(0, 220))
        .filter(Boolean);

      const matchingCommentBlocks = commentBlocks.filter((entry) => entry.includes(commenter) || entry.includes(targetCommentNo.slice(-6)));

      return {
        rootVisible: visible(root),
        rootText: text(root).slice(0, 500),
        rootHtml: String((root && root.innerHTML) || '').slice(0, 2000),
        replyButtonCount: replyButtons.length,
        replyButtons,
        commentBlocks: commentBlocks.slice(0, 10),
        matchingCommentBlocks,
      };
    })()
  `);

  await sleep(8000);

  const afterWait = await frame.evaluate(`
    (() => {
      const logNo = ${JSON.stringify(LOG_NO)};
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const text = (el) => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
      const root = document.querySelector('#naverComment_201_' + logNo + '_ct');
      const host = document.querySelector('#naverComment_201_' + logNo);
      return {
        rootVisible: visible(root),
        rootText: text(root).slice(0, 500),
        hostHtml: String((host && host.innerHTML) || '').slice(0, 2000),
        hostText: text(host).slice(0, 500),
      };
    })()
  `);

  console.log(JSON.stringify({ info, afterWait }, null, 2));
  await page.close().catch(() => {});
  await browser.disconnect();
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
