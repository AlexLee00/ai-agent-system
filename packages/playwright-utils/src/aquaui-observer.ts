// @ts-nocheck
'use strict';

const crypto = require('node:crypto');

function text(value, fallback = '') {
  const normalized = String(value == null ? fallback : value).replace(/\s+/g, ' ').trim();
  return normalized || fallback;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function clip(value, maxLength) {
  const normalized = text(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

async function collectAquaUIObservation(page, options = {}) {
  const maxTextChars = Math.max(200, Number(options.maxTextChars || 4000) || 4000);
  const maxLinks = Math.max(0, Number(options.maxLinks || 20) || 20);
  const maxButtons = Math.max(0, Number(options.maxButtons || 30) || 30);
  const includeScreenshotHash = options.includeScreenshotHash === true;

  const dom = await page.evaluate(({ maxTextChars: evalMaxTextChars, maxLinks: evalMaxLinks, maxButtons: evalMaxButtons }) => {
    const visibleText = document.body?.innerText || '';
    const links = [...document.querySelectorAll('a')]
      .map((node) => ({ text: (node.innerText || node.textContent || '').trim(), href: node.href || '' }))
      .filter((item) => item.text || item.href)
      .slice(0, evalMaxLinks);
    const buttons = [...document.querySelectorAll('button,[role="button"],input[type="button"],input[type="submit"]')]
      .map((node) => ({
        text: (node.innerText || node.textContent || node.value || node.getAttribute('aria-label') || '').trim(),
        disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'),
      }))
      .filter((item) => item.text)
      .slice(0, evalMaxButtons);
    const headings = [...document.querySelectorAll('h1,h2,h3')]
      .map((node) => ({ tag: node.tagName.toLowerCase(), text: (node.innerText || node.textContent || '').trim() }))
      .filter((item) => item.text)
      .slice(0, 20);
    return {
      title: document.title || '',
      url: location.href,
      visibleText: visibleText.slice(0, evalMaxTextChars),
      links,
      buttons,
      headings,
    };
  }, { maxTextChars, maxLinks, maxButtons });

  let screenshotHash = null;
  if (includeScreenshotHash && typeof page.screenshot === 'function') {
    const buffer = await page.screenshot({ encoding: 'binary', fullPage: false }).catch(() => null);
    screenshotHash = buffer ? sha256(buffer) : null;
  }

  const visibleText = clip(dom.visibleText, maxTextChars);
  return {
    ok: true,
    mode: 'aquaui',
    url: text(dom.url),
    title: text(dom.title),
    visibleText,
    visibleTextHash: sha256(visibleText),
    screenshotHash,
    domSummary: {
      headings: dom.headings || [],
      buttons: dom.buttons || [],
      links: dom.links || [],
      counts: {
        headings: dom.headings?.length || 0,
        buttons: dom.buttons?.length || 0,
        links: dom.links?.length || 0,
        visibleTextChars: visibleText.length,
      },
    },
    tokenReduction: {
      rawScreenshotTokensAvoided: true,
      maxTextChars,
    },
    capturedAt: new Date().toISOString(),
  };
}

async function recordAquaUITrace(observation, context = {}) {
  try {
    const eventLake = require('../../core/lib/event-lake');
    return await eventLake.record({
      eventType: 'aquaui_gui_trace',
      team: text(context.team, 'general'),
      botName: text(context.botName || context.bot || context.agent, 'aquaui'),
      severity: 'info',
      traceId: text(context.traceId),
      title: text(context.title, 'AQuaUI GUI trace'),
      message: `${text(observation?.title || observation?.url, 'gui')} text=${observation?.domSummary?.counts?.visibleTextChars || 0}`,
      tags: ['aquaui', 'gui-trace', text(context.scope, 'general')],
      metadata: {
        observation,
        context,
      },
    });
  } catch {
    return null;
  }
}

module.exports = {
  collectAquaUIObservation,
  recordAquaUITrace,
  _testOnly: {
    sha256,
    clip,
  },
};
