const kst = require('../../../packages/core/lib/kst');

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(msg: string): void {
  const ts = kst.toKST(new Date());
  console.log(`[${ts}] ${msg}`);
}
