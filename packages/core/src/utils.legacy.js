'use strict';

/**
 * packages/core/src/utils.js — 공통 유틸리티
 * delay, log (KST timestamp), getTodayKST, getWorkspacePath
 */

const path = require('path');

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.error(`[${ts}] ${msg}`);
}

function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function getWorkspacePath(...parts) {
  return path.join(process.env.HOME, '.openclaw', 'workspace', ...parts);
}

module.exports = { delay, log, getTodayKST, getWorkspacePath };
