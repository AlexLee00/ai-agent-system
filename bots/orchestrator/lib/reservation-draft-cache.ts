'use strict';

const fs = require('fs') as typeof import('node:fs');
const path = require('path') as typeof import('node:path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'reservation-draft-cache.json');
const TTL_MS = 30 * 60 * 1000;
const MAX_FRAGMENTS = 6;

type DraftFragment = {
  text: string;
  ts: number;
};

type DraftCache = Record<string, { fragments?: DraftFragment[] }>;

function ensureCacheDir(): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
}

function readCache(): DraftCache {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as DraftCache;
  } catch {
    return {};
  }
}

function writeCache(cache: DraftCache): void {
  ensureCacheDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function cleanupExpired(cache: DraftCache, now = Date.now()): boolean {
  let dirty = false;
  for (const [chatId, draft] of Object.entries(cache || {})) {
    const fragments = Array.isArray(draft?.fragments)
      ? draft.fragments.filter((item) => now - Number(item?.ts || 0) <= TTL_MS)
      : [];
    if (fragments.length === 0) {
      delete cache[chatId];
      dirty = true;
      continue;
    }
    if (fragments.length !== (draft?.fragments || []).length) {
      cache[chatId] = { fragments };
      dirty = true;
    }
  }
  return dirty;
}

function hasReservationSignals(text = ''): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return [
    /01\d[- ]?\d{3,4}[- ]?\d{4}/,
    /\d{1,2}월\s*\d{1,2}일|오늘|내일|모레|20\d{2}[./-]\d{1,2}[./-]\d{1,2}/,
    /(?:오전|오후)?\s*\d{1,2}시(?:\s*\d{1,2}분?)?|\d{1,2}:\d{2}/,
    /\b(A1|A2|B)\b\s*룸?|\b(A1|A2|B룸?)\b/i,
    /예약|등록|결제|대리예약|다시 등록|반영이 안/,
  ].some((re) => re.test(raw));
}

function isReservationFollowup(text = ''): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  return /(예약해줘|등록해줘|다시\s*등록해줘|다시\s*해줘|다시\s*부탁해|예약이\s*반영이?\s*되지\s*않|예약\s*반영이?\s*안|처리해줘)/i.test(raw);
}

function rememberReservationFragment(chatId: string | number, text: string): void {
  const key = String(chatId || '').trim();
  const raw = String(text || '').trim();
  if (!key || !raw || !hasReservationSignals(raw)) return;

  const cache = readCache();
  cleanupExpired(cache);
  const existing = Array.isArray(cache[key]?.fragments) ? cache[key].fragments || [] : [];
  const fragments = [...existing, { text: raw, ts: Date.now() }].slice(-MAX_FRAGMENTS);
  cache[key] = { fragments };
  writeCache(cache);
}

function getReservationDraft(chatId: string | number): string | null {
  const key = String(chatId || '').trim();
  if (!key) return null;

  const cache = readCache();
  const dirty = cleanupExpired(cache);
  if (dirty) writeCache(cache);
  const fragments = Array.isArray(cache[key]?.fragments) ? cache[key].fragments || [] : [];
  if (fragments.length === 0) return null;
  return fragments.map((item) => item.text).join('\n');
}

function clearReservationDraft(chatId: string | number): void {
  const key = String(chatId || '').trim();
  if (!key) return;
  const cache = readCache();
  if (!cache[key]) return;
  delete cache[key];
  writeCache(cache);
}

function buildReservationIntentText(chatId: string | number, text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return raw;
  if (!isReservationFollowup(raw)) {
    rememberReservationFragment(chatId, raw);
    return raw;
  }

  const draft = getReservationDraft(chatId);
  if (!draft) {
    rememberReservationFragment(chatId, raw);
    return raw;
  }

  const combined = `${draft}\n${raw}`.trim();
  rememberReservationFragment(chatId, combined);
  return combined;
}

module.exports = {
  buildReservationIntentText,
  clearReservationDraft,
  getReservationDraft,
  hasReservationSignals,
  isReservationFollowup,
  rememberReservationFragment,
};
