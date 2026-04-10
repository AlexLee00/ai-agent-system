// @ts-nocheck
/**
 * scripts/pre-market-screen.js — 장전 종목 사전 확정
 *
 * 역할: 장 시작 전 아르고스로 종목 스크리닝 → JSON 파일 저장
 *       장중 domestic.js / overseas.js가 이 파일을 즉시 로드하여 사용
 *
 * 사용: node scripts/pre-market-screen.js domestic|overseas
 * launchd:
 *   국내  KST 08:00 (UTC 23:00 전날) — ai.investment.prescreen-domestic
 *   해외  KST 21:00 (UTC 12:00)      — ai.investment.prescreen-overseas
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

import * as db from '../shared/db.ts';
import {
  getInvestmentTradeMode,
  getKisMarketStatus,
  getKisOverseasMarketStatus,
  getKisSymbols,
  getKisOverseasSymbols,
} from '../shared/secrets.ts';
import { publishToMainBot } from '../shared/mainbot-client.ts';
import { resolveSymbolsWithFallback } from '../shared/universe-fallback.ts';
import { getMockUntradableSymbolCooldownMinutes } from '../shared/runtime-config.ts';
import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');

const OPENCLAW_DIR = join(homedir(), '.openclaw');

const PRESCREENED_FILE = {
  domestic: join(OPENCLAW_DIR, 'domestic-prescreened.json'),
  overseas: join(OPENCLAW_DIR, 'overseas-prescreened.json'),
  crypto:   join(OPENCLAW_DIR, 'crypto-prescreened.json'),
};

const PRESCREENED_TTL_MS     = 4  * 3600 * 1000;  // 4시간 유효 (정규)
const PRESCREENED_RAG_TTL_MS = 24 * 3600 * 1000;  // 24시간 (RAG 폴백)

function shouldSkipPreScreen(status) {
  if (!status) return false;
  if (status.holiday?.isHoliday) return true;
  if (status.isWeekend) return true;
  return false;
}

async function filterMockUntradablePrescreenSymbols(market, symbols, tradeMode = getInvestmentTradeMode()) {
  if (market !== 'domestic' || !Array.isArray(symbols) || symbols.length === 0) return symbols;
  const cooldownMinutes = getMockUntradableSymbolCooldownMinutes();
  const checks = await Promise.all(
    symbols.map(async (symbol) => ({
      symbol,
      blocked: await db.getRecentBlockedSignalByCode({
        symbol,
        action: 'BUY',
        exchange: 'kis',
        tradeMode,
        blockCode: 'mock_untradable_symbol',
        minutesBack: cooldownMinutes,
      }),
    })),
  );
  const filtered = checks.filter((item) => !item.blocked).map((item) => item.symbol);
  const skipped = checks.filter((item) => item.blocked).map((item) => item.symbol);
  if (skipped.length > 0) {
    const cooldownHours = (cooldownMinutes / 60).toFixed(cooldownMinutes % 60 === 0 ? 0 : 1);
    console.log(`  🚫 [prescreen mock 불가 제외] ${skipped.join(', ')} (${cooldownHours}시간 쿨다운)`);
  }
  return filtered;
}

// ─── 공개 유틸 (domestic.js / overseas.js에서 import) ───────────────

/**
 * 장전 스크리닝 결과 로드
 * @param {'domestic'|'overseas'} market
 * @returns {{ symbols: string[], savedAt: number, ... } | null}
 */
export function loadPreScreened(market) {
  const file = PRESCREENED_FILE[market];
  if (!file || !existsSync(file)) return null;
  try {
    const data  = JSON.parse(readFileSync(file, 'utf8'));
    const ageMs = Date.now() - (data.savedAt || 0);
    if (ageMs > PRESCREENED_TTL_MS) {
      console.log(`  ⏰ 장전 스크리닝 파일 만료 (${Math.floor(ageMs / 3600000)}h 경과) — 무시`);
      return null;
    }
    return data;
  } catch { return null; }
}

/**
 * RAG 폴백: 최근 24시간 내 마지막 성공 스크리닝 결과 반환
 * 아르고스 실시간 스크리닝 실패 시 사용
 * @param {'domestic'|'overseas'|'crypto'} market
 * @returns {{ symbols: string[], savedAt: number, ... } | null}
 */
export function loadPreScreenedFallback(market) {
  const file = PRESCREENED_FILE[market];
  if (!file || !existsSync(file)) return null;
  try {
    const data  = JSON.parse(readFileSync(file, 'utf8'));
    const ageMs = Date.now() - (data.savedAt || 0);
    if (ageMs > PRESCREENED_RAG_TTL_MS) {
      console.log(`  ⏰ RAG 폴백 캐시 만료 (${Math.floor(ageMs / 3600000)}h 경과) — 무시`);
      return null;
    }
    return data;
  } catch { return null; }
}

/**
 * 장전 스크리닝 결과 저장
 * @param {'domestic'|'overseas'|'crypto'} market
 * @param {string[]} symbols
 * @param {object} [meta]
 */
export function savePreScreened(market, symbols, meta = {}) {
  const file = PRESCREENED_FILE[market];
  if (!file) return;
  try {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ symbols, savedAt: Date.now(), ...meta }, null, 2));
  } catch (e) {
    console.warn(`  ⚠️ 장전 스크리닝 저장 실패: ${e.message}`);
  }
}

/**
 * 장외 연구 결과를 다음 장 시작에 재사용할 수 있도록 watchlist 메타 갱신
 * - 기존 심볼 목록은 유지/병합
 * - research 섹션만 최신 정보로 덮어씀
 * @param {'domestic'|'overseas'} market
 * @param {string[]} symbols
 * @param {object} meta
 */
export function saveResearchWatchlist(market, symbols, meta = {}) {
  const current = loadPreScreenedFallback(market) || {};
  const mergedSymbols = [...new Set([...(current.symbols || []), ...symbols])];
  const { symbols: _ignoredSymbols, savedAt: _ignoredSavedAt, ...restCurrent } = current;

  savePreScreened(market, mergedSymbols, {
    ...restCurrent,
    ...meta,
    research: {
      mode: 'off_hours',
      updatedAt: Date.now(),
      symbolCount: mergedSymbols.length,
      ...(current.research || {}),
      ...(meta.research || {}),
    },
  });
}

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  const market = process.argv[2];
  if (!['domestic', 'overseas'].includes(market)) {
    console.error('사용법: node scripts/pre-market-screen.js domestic|overseas');
    process.exit(1);
  }

  const label    = market === 'domestic' ? '국내주식' : '미국주식';
  const nowKst   = kst.toKST(new Date());

  console.log(`\n🔍 [장전 스크리닝] ${label} 시작 — ${nowKst}`);

  await db.initSchema();

  if (market === 'domestic' || market === 'overseas') {
    const marketStatus = market === 'domestic'
      ? await getKisMarketStatus()
      : await getKisOverseasMarketStatus();
    if (shouldSkipPreScreen(marketStatus)) {
      console.log(`  ⏭️ [장전 스크리닝] ${label} 스킵 — ${marketStatus.reason}`);
      return;
    }
  }

  const resolved = await resolveSymbolsWithFallback({
    market,
    screen: async () => {
      if (market === 'domestic') {
        const { screenDomesticSymbols } = await import('../team/argos.ts');
        return screenDomesticSymbols();
      }
      const { screenOverseasSymbols } = await import('../team/argos.ts');
      return screenOverseasSymbols();
    },
    defaultSymbols: market === 'domestic' ? getKisSymbols() : getKisOverseasSymbols(),
    screenLabel: `장전 ${label} 스크리닝`,
    cacheLabel: '캐시 폴백',
  });
  const symbols = await filterMockUntradablePrescreenSymbols(market, resolved.symbols);
  const summarizedSymbols = symbols.length <= 6
    ? symbols.join(', ')
    : `${symbols.slice(0, 6).join(', ')} 외 ${symbols.length - 6}개`;

  savePreScreened(market, symbols, { label });
  console.log(`  💾 저장: ${PRESCREENED_FILE[market]}`);

  const msg = `🔍 장전 스크리닝 완료 (${label})\n심볼: ${summarizedSymbols}\n저장: ${kst.timeStr()}`;
  publishToMainBot({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: msg });

  console.log(`\n✅ [장전 스크리닝] ${label} 완료 — ${symbols.length}개 종목`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('❌ 장전 스크리닝 오류:', e.message);
    process.exit(1);
  });
}
