/**
 * scripts/investment-profile.js — 투자 성향 조회
 *
 * config.yaml + 환경변수 + luna.js 상수에서 현재 투자 성향을 종합 반환
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import { isPaperMode } from '../shared/secrets.js';
import { getMinConfidence } from '../team/luna.js';

const require   = createRequire(import.meta.url);
const jsYaml    = require('js-yaml');
const __dirname = dirname(fileURLToPath(import.meta.url));

const FUND_MIN_CONF  = { binance: 0.60, kis: 0.40, kis_overseas: 0.40 };

const EXCHANGE_MAP = {
  domestic: 'kis',
  overseas: 'kis_overseas',
  crypto:   'binance',
};

const RISK_LABEL = {
  domestic: 'aggressive',
  overseas: 'moderate',
  crypto:   'moderate',
};

// nemesis.js RULES
const RULES_STOCK  = { MAX_OPEN_POSITIONS: 5, STOP_LOSS_PCT: 0.05, MAX_ORDER_USDT: 2000, MAX_DAILY_LOSS_PCT: 0.10 };
const RULES_CRYPTO = { MAX_OPEN_POSITIONS: 5, STOP_LOSS_PCT: 0.03, MAX_ORDER_USDT: 1000, MAX_DAILY_LOSS_PCT: 0.05 };

/**
 * 현재 투자 성향 셋팅 조회
 * @param {'domestic'|'overseas'|'crypto'} market
 */
export async function getInvestmentProfile(market) {
  let cfg = {};
  try {
    cfg = jsYaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
  } catch { /* config 없으면 기본값 */ }

  const paperMode = isPaperMode();
  const exchange  = EXCHANGE_MAP[market] || 'binance';
  const isCrypto  = market === 'crypto';
  const rules     = isCrypto ? RULES_CRYPTO : RULES_STOCK;
  const capMgmt   = cfg.capital_management || {};
  const dualModel = process.env.LUNA_DUAL_MODEL !== 'false';

  return {
    market,
    exchange,
    mode:             paperMode ? '🟡 모의투자 (PAPER)' : '🔴 실투자 (LIVE)',
    riskLevel:        RISK_LABEL[market] || 'moderate',
    maxPositions:     rules.MAX_OPEN_POSITIONS,
    riskPerTrade:     (capMgmt.risk_per_trade || 0.02) * 100,   // % 표시
    minConfidence:    getMinConfidence(exchange),
    fundMinConf:      FUND_MIN_CONF[exchange],
    stopLossPct:      rules.STOP_LOSS_PCT * 100,
    maxOrderUsdt:     rules.MAX_ORDER_USDT,
    dailyLossLimit:   rules.MAX_DAILY_LOSS_PCT * 100,
    cashReserve:      (capMgmt.reserve_ratio || 0.10) * 100,
    dualModel,
    paperMode,
  };
}
