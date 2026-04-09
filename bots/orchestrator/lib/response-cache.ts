'use strict';

const _cache = new Map<string, { data: any; expiresAt: number }>();

function get<T = any>(key: string): T | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function set(key: string, data: any, ttlMs = 60_000): void {
  _cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function invalidate(key: string): void {
  _cache.delete(key);
}

function clear(): void {
  _cache.clear();
}

async function cached<T>(key: string, fn: () => Promise<T> | T, ttlMs = 60_000): Promise<T> {
  const hit = get<T>(key);
  if (hit !== null) return hit;
  const result = await fn();
  set(key, result, ttlMs);
  return result;
}

module.exports = { get, set, invalidate, clear, cached };
