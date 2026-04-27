// @ts-nocheck
/**
 * scripts/investment-profile.js — 투자 성향 조회
 *
 * config.yaml + 환경변수 + luna.ts 상수에서 현재 투자 성향을 종합 반환
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import { getMarketExecutionModeInfo } from '../shared/secrets.ts';
import { getMinConfidence } from '../team/luna.ts';
import { getLunaStockStrategyProfile, getInvestmentRuntimeConfig, getNemesisRuntimeConfig } from '../shared/runtime-config.ts';

const require   = createRequire(import.meta.url);
const jsYaml    = require('js-yaml');
const __dirname = dirname(fileURLToPath(import.meta.url));

const EXCHANGE_MAP = {
  domestic: 'kis',
  overseas: 'kis_overseas',
  crypto:   'binance',
};

/**
 * 현재 투자 성향 셋팅 조회
 * @param {'domestic'|'overseas'|'crypto'} market
 */
export async function getInvestmentProfile(market) {
  const exchange  = EXCHANGE_MAP[market] || 'binance';
  const isCrypto  = market === 'crypto';
  const stockProfile = getLunaStockStrategyProfile();
  const runtimeConfig = getInvestmentRuntimeConfig();
  const nemesisConfig = getNemesisRuntimeConfig();
  let cfg = {};
  try {
    cfg = jsYaml.load(readFileSync(join(__dirname, '..', 'config.yaml'), 'utf8')) || {};
  } catch { /* config 없으면 기본값 */ }
  const capMgmt   = cfg.capital_management || {};
  const dualModel = process.env.LUNA_DUAL_MODEL !== 'false';
  const modeInfo  = getMarketExecutionModeInfo(isCrypto ? 'crypto' : 'stocks', market);
  const rules = isCrypto
    ? nemesisConfig.crypto
    : exchange === 'kis'
      ? nemesisConfig.stockDomestic
      : nemesisConfig.stockOverseas;
  const maxPositions = isCrypto
    ? Number(runtimeConfig.luna?.maxPosCount || rules.maxOpenPositions || 0)
    : Number(rules.maxOpenPositions || 0);
  const maxOrderUsdt = isCrypto
    ? Number(rules.maxOrderUsdt || 0)
    : Number(runtimeConfig.luna?.stockOrderDefaults?.[exchange]?.max || rules.maxOrderUsdt || 0);
  const riskLevel = isCrypto
    ? (Number(getMinConfidence(exchange)) <= 0.2 ? 'aggressive' : 'moderate')
    : (stockProfile.label || 'aggressive');
  const fundMinConf = Number(runtimeConfig.luna?.fastPathThresholds?.[isCrypto ? 'minCryptoConfidence' : 'minStockConfidence'] || 0);

  return {
    market,
    exchange,
    mode:             `${modeInfo.executionMode.toUpperCase()} / ${modeInfo.brokerAccountMode.toUpperCase()}`,
    executionMode:    modeInfo.executionMode,
    brokerAccountMode: modeInfo.brokerAccountMode,
    riskLevel,
    maxPositions,
    riskPerTrade:     (capMgmt.risk_per_trade || 0.02) * 100,   // % 표시
    minConfidence:    getMinConfidence(exchange),
    fundMinConf,
    stopLossPct:      Number(rules.stopLossPct || 0) * 100,
    maxOrderUsdt,
    dailyLossLimit:   Number(rules.maxDailyLossPct || 0) * 100,
    cashReserve:      (capMgmt.reserve_ratio || 0.10) * 100,
    dualModel,
    paperMode:        modeInfo.paper,
  };
}
