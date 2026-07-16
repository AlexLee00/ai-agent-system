#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getOverseasDailyPriceBars } from '../shared/kis-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export const JAENONG_PARSER_VERSION = 'jaenong-deterministic-v2';

export const JAENONG_TICKER_DRAFT = Object.freeze({
  AAPL: { company: 'Apple', aliases: ['애플', 'Apple', 'AAPL'], status: 'draft_master_approval_required' },
  MSFT: { company: 'Microsoft', aliases: ['마이크로소프트', 'Microsoft', 'MSFT'], status: 'draft_master_approval_required' },
  NVDA: { company: 'NVIDIA', aliases: ['엔비디아', 'NVIDIA', 'NVDA'], status: 'draft_master_approval_required' },
  AMZN: { company: 'Amazon', aliases: ['아마존', 'Amazon', 'AMZN'], status: 'draft_master_approval_required' },
  GOOGL: { company: 'Alphabet', aliases: ['알파벳', '구글', 'Alphabet', 'Google', 'GOOGL'], status: 'draft_master_approval_required' },
  META: { company: 'Meta', aliases: ['메타', 'Meta', 'META'], status: 'draft_master_approval_required' },
  TSLA: { company: 'Tesla', aliases: ['테슬라', 'Tesla', 'TSLA'], status: 'draft_master_approval_required' },
  AVGO: { company: 'Broadcom', aliases: ['브로드컴', 'Broadcom', 'AVGO'], status: 'draft_master_approval_required' },
  AMD: { company: 'AMD', aliases: ['AMD', '어드밴스드 마이크로 디바이시스'], status: 'draft_master_approval_required' },
  MU: { company: 'Micron', aliases: ['마이크론', 'Micron', 'MU'], status: 'draft_master_approval_required' },
  'BRK.B': { company: 'Berkshire Hathaway', aliases: ['버크셔 해서웨이', '버크셔', 'Berkshire Hathaway', 'BRK.B'], status: 'draft_master_approval_required' },
  JPM: { company: 'JPMorgan', aliases: ['JP모건', '제이피모건', 'JPMorgan', 'JPM'], status: 'draft_master_approval_required' },
  NFLX: { company: 'Netflix', aliases: ['넷플릭스', 'Netflix', 'NFLX'], status: 'draft_master_approval_required' },
  ORCL: { company: 'Oracle', aliases: ['오라클', 'Oracle', 'ORCL'], status: 'draft_master_approval_required' },
});

const LONG_WORDS = ['매수', '분할매수', '사다', '진입', '롱', '상승'];
const SHORT_WORDS = ['매도 관점', '숏', '하락 베팅', '공매도'];
const BUY_WORDS = ['매수', '진입', '사다', '분할', '타점', '줍'];
const SELL_WORDS = ['매도', '목표가', '익절', '청산'];
const STOP_WORDS = ['손절', '이탈', '스탑', 'stop loss'];
const CONDITIONAL_WORDS = ['만약', '경우', '때', '조건', '확인되면', '돌파하면', '이탈하면'];
const PRICE_KEYWORD_DISTANCE = 40;
const NUMBER_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function sentencesOf(content = '') {
  return String(content || '')
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function includesAny(value, words) {
  const text = String(value || '').toLowerCase();
  return words.some((word) => text.includes(word.toLowerCase()));
}

function aliasesForTicker(ticker) {
  return JAENONG_TICKER_DRAFT[ticker]?.aliases || [ticker];
}

function parsePublicationDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function containsTickerAlias(text, alias) {
  const value = String(text || '');
  if (!/^[A-Z0-9. ]+$/i.test(String(alias))) {
    return value.toLowerCase().includes(String(alias).toLowerCase());
  }
  const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}(?=$|[^A-Z0-9])`, 'i').test(value);
}

function mentionedTickers(content) {
  const text = String(content || '');
  return Object.entries(JAENONG_TICKER_DRAFT)
    .filter(([, item]) => item.aliases.some((alias) => containsTickerAlias(text, alias)))
    .map(([ticker]) => ticker);
}

function parseNumber(value) {
  return Number(String(value || '').replaceAll(',', ''));
}

function rangeDistance(left, right) {
  if (left.end < right.start) return right.start - left.end;
  if (right.end < left.start) return left.start - right.end;
  return 0;
}

function keywordRanges(sentence, keywords) {
  const lower = String(sentence || '').toLowerCase();
  const ranges = [];
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    let start = lower.indexOf(needle);
    while (start >= 0) {
      ranges.push({ start, end: start + needle.length, keyword });
      start = lower.indexOf(needle, start + needle.length);
    }
  }
  return ranges;
}

function extractPriceTokens(sentence) {
  const tokens = [];
  const usdRegex = new RegExp(`\\$\\s*(${NUMBER_PATTERN})|(${NUMBER_PATTERN})\\s*(달러|불|usd)`, 'gi');
  for (const match of sentence.matchAll(usdRegex)) {
    const amount = parseNumber(match[1] || match[2]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    tokens.push({
      amount,
      currency: 'USD',
      raw: match[0],
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
    });
  }

  const krwRegex = new RegExp(
    `(${NUMBER_PATTERN})\\s*만(?:\\s*(${NUMBER_PATTERN})\\s*천)?\\s*원`
      + `|(${NUMBER_PATTERN})\\s*천\\s*원`
      + `|(${NUMBER_PATTERN})\\s*원`,
    'gi',
  );
  for (const match of sentence.matchAll(krwRegex)) {
    const amount = match[1]
      ? parseNumber(match[1]) * 10_000 + parseNumber(match[2]) * 1_000
      : match[3]
        ? parseNumber(match[3]) * 1_000
        : parseNumber(match[4]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    tokens.push({
      amount,
      currency: 'KRW',
      raw: match[0],
      start: match.index || 0,
      end: (match.index || 0) + match[0].length,
    });
  }
  return tokens.toSorted((a, b) => a.start - b.start);
}

function explicitHighRanges(sentence) {
  return [...sentence.matchAll(/52\s*주\s*고점/gi)].map((match) => ({
    start: match.index || 0,
    end: (match.index || 0) + match[0].length,
  }));
}

function nearestRange(target, ranges) {
  return ranges.toSorted((a, b) => rangeDistance(a, target) - rangeDistance(b, target))[0] || null;
}

function explicitHighPriceTokens(sentence, tokens) {
  const highTokens = explicitHighRanges(sentence)
    .map((range) => {
      const token = nearestRange(range, tokens);
      return token && rangeDistance(range, token) <= PRICE_KEYWORD_DISTANCE ? token : null;
    })
    .filter(Boolean);
  return [...new Map(highTokens.map((token) => [`${token.start}:${token.end}`, token])).values()];
}

function isExplicitHighToken(sentence, token) {
  if (!/-\s*\d+(?:\.\d+)?\s*%/.test(sentence)) return false;
  const usdTokens = extractPriceTokens(sentence).filter((item) => item.currency === 'USD');
  return explicitHighPriceTokens(sentence, usdTokens)
    .some((item) => item.start === token.start && item.end === token.end);
}

function nearbySentences(content, ticker) {
  const aliases = aliasesForTicker(ticker);
  const sentences = sentencesOf(content);
  const relevant = new Set();
  sentences.forEach((sentence, index) => {
    if (!aliases.some((alias) => containsTickerAlias(sentence, alias))) return;
    relevant.add(sentence);
    if (sentences[index + 1]) relevant.add(sentences[index + 1]);
    if (sentences[index + 2]) relevant.add(sentences[index + 2]);
  });
  return [...relevant];
}

function extractPoint(sentences, keywords) {
  const points = [];
  for (const sentence of sentences) {
    const ranges = keywordRanges(sentence, keywords);
    if (ranges.length === 0) continue;
    const tokens = extractPriceTokens(sentence).filter((token) => (
      token.currency === 'USD' && !isExplicitHighToken(sentence, token)
    ));
    for (const keyword of ranges) {
      const nearest = tokens.toSorted((a, b) => rangeDistance(a, keyword) - rangeDistance(b, keyword))[0];
      if (nearest && rangeDistance(nearest, keyword) <= PRICE_KEYWORD_DISTANCE) {
        points.push({ price: nearest.amount, sourceSpan: sentence });
      }
    }
  }
  return [...new Map(points.map((point) => [`${point.price}:${point.sourceSpan}`, point])).values()];
}

function extractDrawdownPoints(sentences) {
  const points = [];
  for (const sentence of sentences) {
    const entryRanges = keywordRanges(sentence, [...BUY_WORDS, '오면']);
    const exitRanges = keywordRanges(sentence, [...SELL_WORDS, ...STOP_WORDS]);
    const usdTokens = extractPriceTokens(sentence).filter((token) => token.currency === 'USD');
    const highTokens = explicitHighPriceTokens(sentence, usdTokens);
    const genericHighRanges = keywordRanges(sentence, ['고점']);
    for (const match of sentence.matchAll(/-\s*(\d+(?:\.\d+)?)\s*%/g)) {
      const percentage = Number(match[1]);
      const percentageRange = {
        start: match.index || 0,
        end: (match.index || 0) + match[0].length,
      };
      if (!Number.isFinite(percentage) || percentage <= 0 || percentage >= 100) continue;
      const entryRange = nearestRange(percentageRange, entryRanges);
      const exitRange = nearestRange(percentageRange, exitRanges);
      const entryDistance = entryRange ? rangeDistance(entryRange, percentageRange) : Infinity;
      const exitDistance = exitRange ? rangeDistance(exitRange, percentageRange) : Infinity;
      if (entryDistance > PRICE_KEYWORD_DISTANCE || exitDistance <= entryDistance) continue;
      const highToken = highTokens
        .toSorted((a, b) => rangeDistance(a, percentageRange) - rangeDistance(b, percentageRange))[0];
      const missingHighReference = !highToken
        && genericHighRanges.some((range) => rangeDistance(range, percentageRange) <= PRICE_KEYWORD_DISTANCE);
      const basis = highToken
        ? { type: 'explicit_52_week_high', price: highToken.amount }
        : missingHighReference
          ? { type: 'missing_high_reference', price: null }
          : { type: 'publication_reference_price', price: null };
      points.push({
        price: highToken ? round(highToken.amount * (1 - percentage / 100)) : null,
        derived: true,
        drawdownPercent: -percentage,
        basis,
        sourceSpan: sentence,
      });
    }
  }
  return [...new Map(points.map((point) => [
    `${point.drawdownPercent}:${point.basis.type}:${point.basis.price}:${point.sourceSpan}`,
    point,
  ])).values()];
}

function extractCurrencyMismatches(sentences) {
  const mismatches = [];
  for (const sentence of sentences) {
    const ranges = keywordRanges(sentence, [...BUY_WORDS, ...SELL_WORDS, ...STOP_WORDS]);
    for (const token of extractPriceTokens(sentence).filter((item) => item.currency === 'KRW')) {
      if (!ranges.some((range) => rangeDistance(range, token) <= PRICE_KEYWORD_DISTANCE)) continue;
      mismatches.push({
        currency: token.currency,
        amount: token.amount,
        raw: token.raw,
        sourceSpan: sentence,
      });
    }
  }
  return [...new Map(mismatches.map((item) => [`${item.amount}:${item.sourceSpan}`, item])).values()];
}

function inferDirection(sentences) {
  const joined = sentences.join(' ');
  const longHits = LONG_WORDS.filter((word) => includesAny(joined, [word])).length;
  const shortHits = SHORT_WORDS.filter((word) => includesAny(joined, [word])).length;
  return shortHits > longHits ? 'short' : 'long';
}

function extractMarketView(content) {
  const marketWords = ['시장', '증시', '나스닥', 's&p', '연준', '금리', '실적 시즌'];
  return sentencesOf(content).filter((sentence) => includesAny(sentence, marketWords)).slice(0, 3).join(' ');
}

export function parseJaenongPost(post = {}) {
  const content = String(post.content || '');
  const candidates = mentionedTickers(content).map((ticker) => {
    const sourceSpans = nearbySentences(content, ticker);
    const buyPoints = [...extractPoint(sourceSpans, BUY_WORDS), ...extractDrawdownPoints(sourceSpans)];
    const sellPoints = extractPoint(sourceSpans, SELL_WORDS);
    const stopPoints = extractPoint(sourceSpans, STOP_WORDS);
    const currencyMismatches = extractCurrencyMismatches(sourceSpans);
    const conditionalSentence = sourceSpans.find((sentence) => includesAny(sentence, CONDITIONAL_WORDS));
    const evidenceCount = Number(sourceSpans.length > 0)
      + Number(buyPoints.length > 0)
      + Number(sellPoints.length > 0)
      + Number(stopPoints.length > 0);
    return {
      ticker,
      company: JAENONG_TICKER_DRAFT[ticker].company,
      direction: inferDirection(sourceSpans),
      buyPoints,
      sellPoints,
      stopLoss: stopPoints[0] || null,
      currencyMismatches,
      conditional: conditionalSentence
        ? { type: 'conditional', trigger: conditionalSentence }
        : { type: 'unconditional', trigger: null },
      rationale: sourceSpans.join(' '),
      confidence: round(Math.min(1, evidenceCount / 4), 2),
      sourceSpans,
      publishedAt: post.publishedAt || null,
      sourcePostId: post.sourcePostId || null,
    };
  });
  return {
    parserVersion: JAENONG_PARSER_VERSION,
    sourcePostId: post.sourcePostId || null,
    marketView: extractMarketView(content),
    candidates,
  };
}

function sourceSpanExists(content, span) {
  return Boolean(span) && String(content || '').includes(String(span));
}

function tickerNearSpan(content, span, ticker) {
  const text = String(content || '');
  const spanIndex = text.indexOf(String(span || ''));
  if (spanIndex < 0) return false;
  const start = Math.max(0, spanIndex - 240);
  const end = Math.min(text.length, spanIndex + String(span || '').length + 240);
  const neighborhood = text.slice(start, end);
  return aliasesForTicker(ticker).some((alias) => containsTickerAlias(neighborhood, alias));
}

function validatePoint(point, { content, ticker, keywords, range, reasonPrefix }) {
  const reasons = [];
  if (!point || !sourceSpanExists(content, point.sourceSpan)) reasons.push(`${reasonPrefix}_source_span_missing`);
  if (point && !tickerNearSpan(content, point.sourceSpan, ticker)) reasons.push(`${reasonPrefix}_ticker_not_near_span`);
  if (point && !includesAny(point.sourceSpan, keywords)) reasons.push(`${reasonPrefix}_direction_keyword_missing`);
  const price = Number(point?.price);
  if (!Number.isFinite(price) || price <= 0 || price < range[0] || price > range[1]) {
    reasons.push(`${reasonPrefix}_out_of_range`);
  }
  return reasons;
}

function materializeDerivedPoint(point, referencePrice) {
  const output = structuredClone(point);
  if (output?.derived !== true) return output;
  if (output.basis?.type === 'publication_reference_price') {
    output.basis.price = Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null;
  }
  const basisPrice = Number(output.basis?.price);
  const drawdownPercent = Number(output.drawdownPercent);
  output.price = Number.isFinite(basisPrice) && basisPrice > 0 && Number.isFinite(drawdownPercent)
    ? round(basisPrice * (1 + drawdownPercent / 100))
    : null;
  return output;
}

function pointRanges(direction, referencePrice) {
  if (direction === 'short') {
    return {
      buy: [referencePrice * 0.9, referencePrice * 1.5],
      sell: [referencePrice * 0.5, referencePrice * 1.1],
      stop: [referencePrice, referencePrice * 1.5],
    };
  }
  return {
    buy: [referencePrice * 0.5, referencePrice * 1.1],
    sell: [referencePrice * 0.9, referencePrice * 1.5],
    stop: [referencePrice * 0.5, referencePrice],
  };
}

function hasDirectionConflict(candidate) {
  const text = (candidate.sourceSpans || []).join(' ');
  if (candidate.direction === 'short') return includesAny(text, LONG_WORDS) && !includesAny(text, SHORT_WORDS);
  return includesAny(text, SHORT_WORDS) && !includesAny(text, LONG_WORDS);
}

export function validateJaenongBrief(brief = {}, post = {}, referencePrices = {}) {
  const content = String(post.content || '');
  const publicationDateValid = Boolean(parsePublicationDate(post.publishedAt));
  const candidates = (brief.candidates || []).map((candidate) => {
    const ticker = String(candidate.ticker || '').toUpperCase();
    const reasons = [];
    if (!Object.hasOwn(JAENONG_TICKER_DRAFT, ticker)) reasons.push('ticker_not_whitelisted');
    const referencePrice = Number(referencePrices[ticker]);
    const normalizedCandidate = {
      ...structuredClone(candidate),
      buyPoints: (candidate.buyPoints || []).map((point) => materializeDerivedPoint(point, referencePrice)),
    };
    if (!publicationDateValid) reasons.push('invalid_publication_date');
    if (!Number.isFinite(referencePrice) || referencePrice <= 0) reasons.push('reference_price_missing');
    for (const span of normalizedCandidate.sourceSpans || []) {
      if (!sourceSpanExists(content, span)) reasons.push('source_span_missing');
    }
    if (!['long', 'short'].includes(normalizedCandidate.direction)) reasons.push('direction_invalid');
    if (hasDirectionConflict(normalizedCandidate)) reasons.push('direction_conflict');
    if ((normalizedCandidate.currencyMismatches || []).length > 0) reasons.push('currency_mismatch');

    if (Number.isFinite(referencePrice) && referencePrice > 0) {
      const ranges = pointRanges(normalizedCandidate.direction, referencePrice);
      for (const point of normalizedCandidate.buyPoints || []) {
        if (point.derived && point.basis?.type === 'missing_high_reference') {
          reasons.push('drawdown_basis_missing');
        }
        reasons.push(...validatePoint(point, {
          content,
          ticker,
          keywords: point.derived ? [...BUY_WORDS, '오면'] : BUY_WORDS,
          range: ranges.buy,
          reasonPrefix: 'buy_point',
        }));
      }
      for (const point of normalizedCandidate.sellPoints || []) {
        reasons.push(...validatePoint(point, {
          content, ticker, keywords: SELL_WORDS, range: ranges.sell, reasonPrefix: 'sell_point',
        }));
      }
      if (normalizedCandidate.stopLoss) {
        reasons.push(...validatePoint(normalizedCandidate.stopLoss, {
          content, ticker, keywords: STOP_WORDS, range: ranges.stop, reasonPrefix: 'stop_loss',
        }));
      }
    }
    if (!(normalizedCandidate.buyPoints || []).length) reasons.push('buy_point_missing');
    const unavailableReasons = [...new Set(reasons)];
    return {
      ...normalizedCandidate,
      ticker,
      referencePrice: Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null,
      available: unavailableReasons.length === 0,
      unavailableReasons,
    };
  });
  return {
    ...structuredClone(brief),
    candidates,
    status: candidates.length > 0 && candidates.every((candidate) => candidate.available)
      ? 'available'
      : candidates.some((candidate) => candidate.available)
        ? 'partial'
        : 'unavailable',
  };
}

export async function pointInTimeReferencePrice(ticker, publishedAt, options = {}) {
  const date = parsePublicationDate(publishedAt);
  if (!date) return null;
  const endDate = date.toISOString().slice(0, 10).replaceAll('-', '');
  const bars = await (options.getBars || getOverseasDailyPriceBars)(ticker, { days: 20, endDate });
  const target = date.toISOString().slice(0, 10).replaceAll('-', '');
  const eligible = (bars || []).filter((bar) => (
    String(bar.date || bar.timestamp || '').slice(0, 10).replaceAll('-', '') <= target
  ));
  return Number(eligible.at(-1)?.close || 0) || null;
}

export async function parseStoredJaenongPosts(options = {}, deps = {}) {
  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  const rows = await queryFn(
    `SELECT id, source_post_id, source_url, title, published_at, content_snapshot
       FROM investment.jaenong_posts
      ORDER BY published_at DESC NULLS LAST, id DESC
      LIMIT $1`,
    [Math.max(1, Number(options.limit || 100) || 100)],
  );
  const results = [];
  for (const row of rows || []) {
    const post = {
      sourcePostId: row.source_post_id,
      url: row.source_url,
      title: row.title,
      publishedAt: row.published_at,
      content: row.content_snapshot,
    };
    const draft = parseJaenongPost(post);
    const prices = {};
    for (const candidate of draft.candidates) {
      prices[candidate.ticker] = await pointInTimeReferencePrice(
        candidate.ticker,
        post.publishedAt,
        { getBars: deps.getBars },
      ).catch(() => null);
    }
    const brief = validateJaenongBrief(draft, post, prices);
    if (options.write === true) {
      const reasons = brief.candidates.flatMap((candidate) => candidate.unavailableReasons || []);
      await runFn(
        `INSERT INTO investment.jaenong_post_scores
           (post_id, parser_version, brief, status, unavailable_reasons)
         VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
         ON CONFLICT (post_id, parser_version) DO UPDATE SET
           brief = EXCLUDED.brief,
           status = EXCLUDED.status,
           unavailable_reasons = EXCLUDED.unavailable_reasons,
           scored_at = now()`,
        [row.id, JAENONG_PARSER_VERSION, JSON.stringify(brief), brief.status, JSON.stringify([...new Set(reasons)])],
      );
    }
    results.push({ postId: row.id, sourcePostId: row.source_post_id, brief });
  }
  return results;
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  void runCliMain({
    run: () => parseStoredJaenongPosts({
      write: argv.includes('--write'),
      limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100),
    }),
    onSuccess: (results) => console.log(JSON.stringify({
      ok: true,
      parsed: results.length,
      available: results.filter((row) => row.brief.status === 'available').length,
      partial: results.filter((row) => row.brief.status === 'partial').length,
      unavailable: results.filter((row) => row.brief.status === 'unavailable').length,
      write: argv.includes('--write'),
    }, null, 2)),
    errorPrefix: 'jaenong parser failed:',
  });
}
