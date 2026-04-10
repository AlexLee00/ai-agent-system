#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

const env = require('../../../packages/core/lib/env');
const { parseNaverBlogUrl } = require(path.join(__dirname, '../../../packages/core/lib/naver-blog-url'));
const { getBlogCommenterConfig } = require('../lib/runtime-config');
const { getViewCollectionCandidates, recordPerformancePartial } = require('../lib/publ');

const NAV_TIMEOUT_MS = 45000;
const NAVER_MONITOR_WS_FILE = path.join(env.OPENCLAW_WORKSPACE, 'naver-monitor-ws.txt');

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
  const text = [
    payload.text,
    payload.html,
    ...(Array.isArray(payload.selectorTexts) ? payload.selectorTexts : []),
    ...(Array.isArray(payload.metaTexts) ? payload.metaTexts : []),
    ...(Array.isArray(payload.scriptTexts) ? payload.scriptTexts : []),
  ].filter(Boolean).join('\n');
  return {
    views: extractMetricFromText(text, '조회수')
      || extractMetricFromText(text, '조회')
      || extractMetricFromText(text, '방문'),
    comments: extractMetricFromText(text, '댓글'),
    likes: extractMetricFromText(text, '공감')
      || extractMetricFromText(text, '좋아요')
      || extractMetricFromText(text, '좋아'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function readNaverMonitorWsEndpoint() {
  try {
    return String(fs.readFileSync(NAVER_MONITOR_WS_FILE, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function buildPostStatUrl(parsed) {
  if (!parsed?.ok || !parsed?.logNo) return '';
  return `https://blog.stat.naver.com/blog/article/${parsed.logNo}/cv`;
}

function extractMetricByLabel(text, label) {
  const normalized = String(text || '').replace(/\u00a0/g, ' ');
  const patterns = [
    new RegExp(`${label}\\s*([0-9,]+)`, 'i'),
    new RegExp(`${label}[\\s\\S]{0,20}?([0-9,]+)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return toNumber(match[1]);
  }
  return 0;
}

async function collectStatsFromStatPage(page, statUrl) {
  if (!statUrl) return null;
  await page.goto(statUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
  await sleep(1200);

  const payload = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : '',
  }));

  const text = String(payload?.text || '');
  if (!text || /로그인|아이디 또는 전화번호|비밀번호/.test(text)) {
    return null;
  }

  const views = extractMetricByLabel(text, '누적 조회수') || extractMetricByLabel(text, '조회수');
  const likes = extractMetricByLabel(text, '누적 공감수') || extractMetricByLabel(text, '공감수');
  const comments = extractMetricByLabel(text, '누적 댓글수') || extractMetricByLabel(text, '댓글수');

  if (views <= 0 && likes <= 0 && comments <= 0) {
    return null;
  }

  return {
    views,
    likes,
    comments,
    source: 'naver_stat_page',
    url: payload.url || statUrl,
  };
}

async function collectRenderedStats(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
  await sleep(1500);

  const primary = await page.evaluate(() => {
    const body = document.body ? document.body.innerText : '';
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const selectorTexts = Array.from(document.querySelectorAll([
      '[class*="view"]',
      '[id*="view"]',
      '[class*="visit"]',
      '[id*="visit"]',
      '[class*="comment"]',
      '[id*="comment"]',
      '[class*="sympathy"]',
      '[id*="sympathy"]',
      '[class*="like"]',
      '[id*="like"]',
      '[data-count]',
      '[aria-label*="조회"]',
      '[aria-label*="댓글"]',
      '[aria-label*="공감"]',
    ].join(',')))
      .map((el) => String(el.innerText || el.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 80);
    const metaTexts = Array.from(document.querySelectorAll('meta'))
      .map((el) => String(el.getAttribute('content') || '').trim())
      .filter(Boolean)
      .filter((text) => /조회|댓글|공감|좋아요|like|comment|view|visit/i.test(text))
      .slice(0, 40);
    const scriptTexts = Array.from(document.querySelectorAll('script'))
      .map((el) => String(el.textContent || '').trim())
      .filter(Boolean)
      .filter((text) => /viewCount|visitor|commentCount|sympathy|likeCount|조회수|댓글|공감/i.test(text))
      .slice(0, 20);
    return { text: body, html, selectorTexts, metaTexts, scriptTexts };
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
        const selectorTexts = Array.from(document.querySelectorAll([
          '[class*="view"]',
          '[id*="view"]',
          '[class*="visit"]',
          '[id*="visit"]',
          '[class*="comment"]',
          '[id*="comment"]',
          '[class*="sympathy"]',
          '[id*="sympathy"]',
          '[class*="like"]',
          '[id*="like"]',
          '[data-count]',
          '[aria-label*="조회"]',
          '[aria-label*="댓글"]',
          '[aria-label*="공감"]',
        ].join(',')))
          .map((el) => String(el.innerText || el.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 80);
        const metaTexts = Array.from(document.querySelectorAll('meta'))
          .map((el) => String(el.getAttribute('content') || '').trim())
          .filter(Boolean)
          .filter((text) => /조회|댓글|공감|좋아요|like|comment|view|visit/i.test(text))
          .slice(0, 40);
        const scriptTexts = Array.from(document.querySelectorAll('script'))
          .map((el) => String(el.textContent || '').trim())
          .filter(Boolean)
          .filter((text) => /viewCount|visitor|commentCount|sympathy|likeCount|조회수|댓글|공감/i.test(text))
          .slice(0, 20);
        return { text: body, html, selectorTexts, metaTexts, scriptTexts };
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
  const wsEndpoint = readNaverMonitorWsEndpoint();
  if (wsEndpoint) {
    try {
      const browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
        protocolTimeout: NAV_TIMEOUT_MS,
      });
      try {
        return await fn(browser);
      } finally {
        await browser.disconnect().catch(() => {});
      }
    } catch (error) {
      console.warn(`[collect-views] naver-monitor ws 연결 실패 — 로컬 브라우저로 폴백: ${error.message}`);
    }
  }

  const config = getBlogCommenterConfig();
  const profileDir = expandHome(config.profileDir || '~/.openclaw/workspace/naver-profile');
  let tempProfileDir = null;
  let browser = null;

  const launchWithProfile = async (userDataDir) => puppeteer.launch({
    headless: headful ? false : 'new',
    userDataDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    try {
      browser = await launchWithProfile(profileDir);
    } catch (error) {
      tempProfileDir = path.join(os.tmpdir(), `blog-views-profile-${Date.now()}`);
      console.warn(`[collect-views] 기본 프로필 실행 실패 — 복제 프로필로 재시도: ${error.message}`);
      if (profileDir && fs.existsSync(profileDir)) {
        fs.cpSync(profileDir, tempProfileDir, { recursive: true });
      } else {
        fs.mkdirSync(tempProfileDir, { recursive: true });
      }
      browser = await launchWithProfile(tempProfileDir);
    }

    return await fn(browser);
  } finally {
    await browser?.close().catch(() => {});
    if (tempProfileDir) {
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    }
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
      const targetUrl = parsed.ok ? (parsed.canonicalUrl || rawUrl) : rawUrl;
      const statUrl = buildPostStatUrl(parsed);

      if (!targetUrl) {
        results.push({ ok: false, postId: post.id, title: post.title, error: '네이버 URL 없음' });
        continue;
      }

      try {
        let stats = null;
        if (statUrl) {
          stats = await collectStatsFromStatPage(page, statUrl).catch((error) => {
            console.warn(`[collect-views] ${post.id} 통계 페이지 실패 — 본문 파싱으로 폴백: ${error.message}`);
            return null;
          });
        }
        if (!stats) {
          stats = await collectRenderedStats(page, targetUrl);
        }

        if (!args.dryRun) {
          await recordPerformancePartial(post.id, {
            views: Number(stats.views || 0),
            comments: Number(stats.comments || 0),
            likes: Number(stats.likes || 0),
          });
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
