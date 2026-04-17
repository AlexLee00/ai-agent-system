'use strict';

const BUY_PROMOTION_PATTERNS = [
  /[A-Z]{3,5}\s*(매수|사세요|추천합니다|추천)/,
  /지금\s*(사야|매수해야)/,
  /꼭\s*사세요/,
  /무조건\s*(사야|매수)/,
];

const GUARANTEE_PATTERNS = [
  /수익\s*보장/,
  /원금\s*보장/,
  /\d+%\s*수익\s*확정/,
  /손실\s*없이/,
];

const DISCLAIMER_RE =
  /본\s*글은.*투자\s*권유.*아닙니다|투자\s*판단은.*본인|정보\s*제공\s*목적.*투자\s*권유/;

const DISCLAIMER_TEXT =
  '\n\n> 📌 본 글은 정보 제공 목적이며 투자 권유가 아닙니다. 투자 판단과 책임은 본인에게 있습니다.';

/**
 * 루나 요청 유래 포스트에만 적용.
 * 매수 권유·수익 확약 감지 + 면책 문구 필수 추가.
 * @returns {{ passed: boolean, warnings: string[], mustAdd: string[] }}
 */
function checkInvestmentContent(body, title) {
  const warnings = [];
  const mustAdd  = [];
  const combined = `${title}\n${body}`;

  for (const p of BUY_PROMOTION_PATTERNS) {
    if (p.test(combined)) {
      warnings.push(`매수 권유 감지: ${p.source}`);
    }
  }

  for (const p of GUARANTEE_PATTERNS) {
    if (p.test(combined)) {
      warnings.push(`수익 확약 표현 감지: ${p.source}`);
    }
  }

  if (!DISCLAIMER_RE.test(body)) {
    mustAdd.push(DISCLAIMER_TEXT);
  }

  return { passed: warnings.length === 0, warnings, mustAdd };
}

module.exports = { checkInvestmentContent };
