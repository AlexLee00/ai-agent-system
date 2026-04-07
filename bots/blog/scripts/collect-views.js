#!/usr/bin/env node
'use strict';

const path = require('path');
const puppeteer = require('puppeteer');

const { parseNaverBlogUrl } = require(path.join(__dirname, '../../../packages/core/lib/naver-blog-url'));
const { getViewCollectionCandidates, recordPerformancePartial } = require('../lib/publ');

const NAV_TIMEOUT_MS = 45000;

function parseArgs(argv = process.argv.slice(2)) {
  const get = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  return {
    days: Number(get('days') || 14),
    limit: Number(get('limit') || 10),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    headful: argv.includes('--headful'),
  };
}

function toNumber(value) {
  return Number(String(value || '').replace(/[^\d]/g, '')) || 0;
}

function extractMetricFromText(text, label) {
  const patterns = [
    new RegExp(`${label}\\s*[:：]?\\s*([0-9,]+)`, 'i'),
    new RegExp(`${label}[\\s\\S]{0,20}?([0-9,]+)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return toNumber(match[1]);
  }
  return 0;
}

function extractViewsFromPayload(payload = {}) {
  const text = [payload.text, payload.html].filter(Boolean).join('\n');
  return {
    views: extractMetricFromText(text, '조회수'),
    comments: extractMetricFromText(text, '댓글'),
    likes: extractMetricFromText(text, '공감'),
  };
}

async function collectRenderedStats(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(1500);

  const primary = await page.evaluate(() => {
    const body = document.body ? document.body.innerText : '';
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    return { text: body, html };
  });

  const fromPrimary = extractViewsFromPayload(primary);
  if (fromPrimary.views > 0) {
    return { ...fromPrimary, source: 'puppeteer_text' };
  }

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const payload = await frame.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        const html = document.documentElement ? document.documentElement.outerHTML : '';
        return { text: body, html };
      });
      const stats = extractViewsFromPayload(payload);
      if (stats.views > 0) {
        return { ...stats, source: 'puppeteer_frame' };
      }
    } catch {
      // Cross-origin frames are ignored.
    }
  }

  return { ...fromPrimary, source: 'puppeteer_zero' };
}

async function withBrowser(fn, { headful = false } = {}) {
  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs();
  const candidates = await getViewCollectionCandidates(args.days, args.limit);
  const results = [];
  let updated = 0;

  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1200 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    for (const post of candidates) {
      const rawUrl = post.naver_url || post.metadata?.url || null;
      const parsed = parseNaverBlogUrl(rawUrl || '');
      const targetUrl = parsed.ok ? parsed.mobileUrl : rawUrl;

      if (!targetUrl) {
        results.push({ ok: false, postId: post.id, title: post.title, error: '네이버 URL 없음' });
        continue;
      }

      try {
        const stats = await collectRenderedStats(page, targetUrl);

        if (!args.dryRun) {
          await recordPerformancePartial(post.id, { views: Number(stats.views || 0) });
          updated++;
        }

        results.push({
          ok: true,
          postId: post.id,
          title: post.title,
          views: Number(stats.views || 0),
          comments: Number(stats.comments || 0),
          likes: Number(stats.likes || 0),
          source: stats.source,
          url: targetUrl,
        });
      } catch (error) {
        console.warn(`[collect-views] ${post.id} 실패: ${error.message}`);
        results.push({
          ok: false,
          postId: post.id,
          title: post.title,
          error: error.message,
          url: targetUrl,
        });
      }
    }

    await page.close().catch(() => {});
  }, { headful: args.headful });

  const payload = {
    ok: true,
    candidates: candidates.length,
    updated,
    dryRun: args.dryRun,
    results,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`✅ 조회수 수집 완료: ${updated}건 갱신${args.dryRun ? ' (dry-run)' : ''}`);
  results.forEach((item) => {
    if (!item.ok) {
      console.log(`- ❌ ${item.postId} ${item.title}: ${item.error}`);
      return;
    }
    console.log(`- ✅ ${item.postId} ${item.title} | views=${item.views} (${item.source})`);
  });
}

main().catch((error) => {
  console.error(`❌ ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
