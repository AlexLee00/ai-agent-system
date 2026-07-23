// @ts-nocheck
'use strict';

const FINAL_CANCELLATION_STATUSES = ['취소완료', '환불완료', '환불성공'];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function assessPickkoCancellationEvidence({ statusTexts = [] } = {}) {
  for (const raw of statusTexts) {
    const text = normalizeText(raw);
    const status = FINAL_CANCELLATION_STATUSES.find((candidate) => text.includes(candidate));
    if (status) return { confirmed: true, status };
  }
  return { confirmed: false, status: null };
}

export async function verifyPickkoCancellation(page, viewHref, { delay = async () => {} } = {}) {
  await page.goto(viewHref, { waitUntil: 'domcontentloaded', timeout: 20_000 });
  await delay(500);
  const snapshot = await page.evaluate(() => ({
    statusTexts: Array.from(document.querySelectorAll('tbody tr, table tr, [class*="status"], [class*="state"]'))
      .map((element) => String(element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 100),
  }));
  return {
    ...assessPickkoCancellationEvidence(snapshot),
    statusTexts: snapshot.statusTexts.slice(0, 10),
  };
}

export default {
  assessPickkoCancellationEvidence,
  verifyPickkoCancellation,
};
