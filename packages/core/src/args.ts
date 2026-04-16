// @ts-nocheck
'use strict';

/**
 * packages/core/src/args.js — CLI 인자 파서
 * bots/reservation/lib/args.js에서 복사 (원본 유지)
 *
 * 지원 형식: --key=value, --key value
 * process.argv 전체를 받아 index 2부터 파싱
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, vRaw] = a.slice(2).split('=');
    const v = vRaw ?? argv[i + 1];
    if (vRaw === undefined) i++;
    out[k] = v;
  }
  return out;
}

module.exports = { parseArgs };
