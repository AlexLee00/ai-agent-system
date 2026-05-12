// @ts-nocheck
/**
 * kis-symbol-policy — KIS 종목 WHITELIST/BLACKLIST 정책
 *
 * 데이터 기반: 33 LIVE 거래 분석 (2026-05-12)
 * WHITELIST: 반복 + 양수 PnL 종목
 * BLACKLIST: 반복 + 손실 종목 (2건+ AND 0% 승률)
 * AVOID: 1건 -$30 이상 손실 종목
 */

export type KisSymbolPolicyType = 'whitelist' | 'blacklist' | 'avoid' | 'neutral';

export interface KisSymbolPolicy {
  symbol: string;
  policy: KisSymbolPolicyType;
  rationale: string;
  trades?: number;
  win_rate?: number;
  total_pnl_usd?: number;
}

export const KIS_SYMBOL_POLICY: KisSymbolPolicy[] = [
  // ⭐ WHITELIST — 반복 + 양수 PnL
  { symbol: '006110', policy: 'whitelist', rationale: '100% 승률 (2거래) +$58', trades: 2, win_rate: 100, total_pnl_usd: 57.99 },
  { symbol: '005090', policy: 'whitelist', rationale: '20% 승률 (5거래) +$18', trades: 5, win_rate: 20, total_pnl_usd: 18.15 },
  { symbol: '375500', policy: 'whitelist', rationale: '100% 승률 (1거래) +$14', trades: 1, win_rate: 100, total_pnl_usd: 14.41 },
  { symbol: '005810', policy: 'whitelist', rationale: '100% 승률 (1거래) +$2', trades: 1, win_rate: 100, total_pnl_usd: 1.76 },

  // 🚨 BLACKLIST — 반복 (2건+) + 0% 승률
  { symbol: '018470', policy: 'blacklist', rationale: '0% 승률 (3거래) -$54', trades: 3, win_rate: 0, total_pnl_usd: -54.31 },
  { symbol: '100090', policy: 'blacklist', rationale: '0% 승률 (2거래) -$46', trades: 2, win_rate: 0, total_pnl_usd: -45.64 },
  { symbol: '008350', policy: 'blacklist', rationale: '0% 승률 (2거래) -$43', trades: 2, win_rate: 0, total_pnl_usd: -43.43 },
  { symbol: '322000', policy: 'blacklist', rationale: '0% 승률 (2거래) -$37', trades: 2, win_rate: 0, total_pnl_usd: -37.34 },
  { symbol: '066970', policy: 'blacklist', rationale: '0% 승률 (2거래) -$24', trades: 2, win_rate: 0, total_pnl_usd: -24.40 },
  { symbol: '005870', policy: 'blacklist', rationale: '0% 승률 (2거래) -$14', trades: 2, win_rate: 0, total_pnl_usd: -13.73 },

  // 🚫 AVOID — 1건 -$30 이상 손실
  { symbol: '004960', policy: 'avoid', rationale: '-$67 단일 손실', trades: 1, win_rate: 0, total_pnl_usd: -66.89 },
  { symbol: '105840', policy: 'avoid', rationale: '-$54 단일 손실', trades: 1, win_rate: 0, total_pnl_usd: -53.51 },
  { symbol: '013000', policy: 'avoid', rationale: '-$46 단일 손실', trades: 1, win_rate: 0, total_pnl_usd: -45.91 },
  { symbol: '003535', policy: 'avoid', rationale: '-$43 단일 손실', trades: 1, win_rate: 0, total_pnl_usd: -42.63 },
  { symbol: '006340', policy: 'avoid', rationale: '-$38 단일 손실', trades: 1, win_rate: 0, total_pnl_usd: -38.48 },
];

export function normalizeKisSymbol(symbol: string): string {
  const normalized = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/^A/, '')
    .replace(/\.KS$|\.KQ$/, '')
    .replace(/[^0-9]/g, '');
  return normalized.padStart(6, '0').slice(-6);
}

export function getKisSymbolPolicy(symbol: string): KisSymbolPolicy {
  const normalized = normalizeKisSymbol(symbol);
  return KIS_SYMBOL_POLICY.find((p) => p.symbol === normalized) ?? {
    symbol: normalized,
    policy: 'neutral',
    rationale: 'No historical data',
  };
}

export function isKisSymbolAllowed(symbol: string): boolean {
  const policy = getKisSymbolPolicy(symbol);
  return policy.policy !== 'blacklist' && policy.policy !== 'avoid';
}

export function getKisSymbolBlockReason(symbol: string): string | null {
  const policy = getKisSymbolPolicy(symbol);
  if (policy.policy === 'blacklist' || policy.policy === 'avoid') {
    return `[KIS/SymbolPolicy] ${symbol} ${policy.policy}: ${policy.rationale}`;
  }
  return null;
}

export function isKisWhitelistedSymbol(symbol: string): boolean {
  return getKisSymbolPolicy(symbol).policy === 'whitelist';
}

export function isKisBlacklistedSymbol(symbol: string): boolean {
  return getKisSymbolPolicy(symbol).policy === 'blacklist';
}

export function isKisAvoidSymbol(symbol: string): boolean {
  return getKisSymbolPolicy(symbol).policy === 'avoid';
}

export function evaluateKisSymbolPolicy(symbol: string) {
  const policy = getKisSymbolPolicy(symbol);
  const blockReason = getKisSymbolBlockReason(symbol);
  return {
    ...policy,
    allowed: isKisSymbolAllowed(symbol),
    blocked: Boolean(blockReason),
    blockReason,
    shadowOnly: true,
  };
}

export default {
  KIS_SYMBOL_POLICY,
  normalizeKisSymbol,
  getKisSymbolPolicy,
  isKisSymbolAllowed,
  getKisSymbolBlockReason,
  isKisWhitelistedSymbol,
  isKisBlacklistedSymbol,
  isKisAvoidSymbol,
  evaluateKisSymbolPolicy,
};
