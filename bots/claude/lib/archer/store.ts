// @ts-nocheck
'use strict';

/**
 * lib/archer/store.js — 이전 실행 결과 캐시 (버전 diff 기준값)
 */

const fs  = require('fs');
const cfg = require('./config');

function load() {
  try {
    return JSON.parse(fs.readFileSync(cfg.OUTPUT.cacheFile, 'utf8'));
  } catch {
    return {};
  }
}

function save(data) {
  try {
    fs.writeFileSync(cfg.OUTPUT.cacheFile, JSON.stringify({
      lastRun:  new Date().toISOString(),
      ...data,
    }, null, 2));
  } catch { /* ignore */ }
}

module.exports = { load, save };
