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

import * as db from '../shared/db.js';
import { getKisSymbols, getKisOverseasSymbols } from '../shared/secrets.js';
import { publishToMainBot } from '../shared/mainbot-client.js';

const OPENCLAW_DIR = join(homedir(), '.openclaw');

const PRESCREENED_FILE = {
  domestic: join(OPENCLAW_DIR, 'domestic-prescreened.json'),
  overseas: join(OPENCLAW_DIR, 'overseas-prescreened.json'),
  crypto:   join(OPENCLAW_DIR, 'crypto-prescreened.json'),
};

const PRESCREENED_TTL_MS     = 4  * 3600 * 1000;  // 4시간 유효 (정규)
const PRESCREENED_RAG_TTL_MS = 24 * 3600 * 1000;  // 24시간 (RAG 폴백)

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

// ─── 메인 ───────────────────────────────────────────────────────────

async function main() {
  const market = process.argv[2];
  if (!['domestic', 'overseas'].includes(market)) {
    console.error('사용법: node scripts/pre-market-screen.js domestic|overseas');
    process.exit(1);
  }

  const label    = market === 'domestic' ? '국내주식' : '미국주식';
  const nowKst   = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  console.log(`\n🔍 [장전 스크리닝] ${label} 시작 — ${nowKst}`);

  await db.initSchema();

  let symbols;
  try {
    if (market === 'domestic') {
      const { screenDomesticSymbols } = await import('../team/argos.js');
      const result = await screenDomesticSymbols();
      symbols = result.all;
    } else {
      const { screenOverseasSymbols } = await import('../team/argos.js');
      const result = await screenOverseasSymbols();
      symbols = result.all;
    }
    console.log(`  ✅ 아르고스 스크리닝 완료: ${symbols.join(', ')}`);
  } catch (e) {
    console.warn(`  ⚠️ 아르고스 스크리닝 실패 → config.yaml 종목 사용: ${e.message}`);
    symbols = market === 'domestic' ? getKisSymbols() : getKisOverseasSymbols();
  }

  savePreScreened(market, symbols, { label });
  console.log(`  💾 저장: ${PRESCREENED_FILE[market]}`);

  const msg = `🔍 장전 스크리닝 완료 (${label})\n심볼: ${symbols.join(', ')}\n저장: ${new Date().toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}`;
  publishToMainBot({ from_bot: 'luna', event_type: 'report', alert_level: 1, message: msg });

  console.log(`\n✅ [장전 스크리닝] ${label} 완료 — ${symbols.length}개 종목`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('❌ 장전 스크리닝 오류:', e.message);
    process.exit(1);
  });
}
