export async function waitForPickkoRefundPage({
  browser,
  openerPage,
  existingPages = [],
  selector = 'a.pay_refund_app, a.pay_refund',
  timeoutMs = 5_000,
  pollMs = 100,
  delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: {
  browser: any;
  openerPage: any;
  existingPages?: any[];
  selector?: string;
  timeoutMs?: number;
  pollMs?: number;
  delay?: (ms: number) => Promise<void>;
}) {
  const existing = new Set(existingPages);
  const openerTarget = typeof openerPage?.target === 'function' ? openerPage.target() : null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const pages = await browser.pages();
    const candidates = pages.filter((page: any) => page === openerPage || !existing.has(page));
    for (const page of candidates) {
      if (page !== openerPage && openerTarget) {
        if (typeof page?.target !== 'function') continue;
        const target = page.target();
        if (typeof target?.opener !== 'function' || target.opener() !== openerTarget) continue;
      }
      const found = await page.$(selector).catch(() => null);
      if (found) return page;
    }
    if (Date.now() >= deadline) break;
    await delay(pollMs);
  }
  return null;
}

export default { waitForPickkoRefundPage };
