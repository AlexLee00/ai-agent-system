// @ts-nocheck
'use strict';

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^가-힣a-z0-9]/gi, '')
    .trim();
}

function normalizeAuthor(value) {
  return String(value || '')
    .split(',')
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .join('|');
}

function isAuthorCompatible(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.includes(right) || right.includes(left);
}

function extractIsbn13(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  return digits.length === 13 ? digits : '';
}

function verifyBookSources(input = {}) {
  const primary = input.primary || input.book || null;
  const candidates = Array.isArray(input.candidates)
    ? input.candidates.filter(Boolean)
    : Array.isArray(primary?.verification_candidates)
      ? primary.verification_candidates.filter(Boolean)
      : (primary ? [primary] : []);

  const reasons = [];
  if (!primary) {
    return {
      ok: false,
      book: null,
      reasons: ['missing primary book candidate'],
      verification: {
        isbn13: null,
        matched_sources: 0,
        title_consistent: false,
        author_consistent: false,
      },
    };
  }

  if (String(primary.source || '') === 'fallback') {
    reasons.push('fallback source is not allowed for book review');
  }

  const canonicalTitle = normalizeText(primary.title);
  const canonicalAuthor = normalizeAuthor(primary.author);
  const isbn13 = extractIsbn13(primary.isbn);

  if (!isbn13) reasons.push('isbn13 is required');

  const matched = [];
  let authorConsistent = false;
  for (const candidate of candidates) {
    const candidateIsbn = extractIsbn13(candidate.isbn);
    const candidateTitle = normalizeText(candidate.title);
    const candidateAuthor = normalizeAuthor(candidate.author);
    const titleConsistent = !!canonicalTitle && candidateTitle === canonicalTitle;
    const authorMatch = !!canonicalAuthor && isAuthorCompatible(candidateAuthor, canonicalAuthor);
    if (authorMatch) authorConsistent = true;
    if (candidateIsbn && titleConsistent && candidateIsbn === isbn13) {
      matched.push(candidate);
    }
  }

  const uniqueSources = [...new Set(matched.map((candidate) => String(candidate.source || 'unknown')))];
  const titleConsistent = matched.length > 0;

  if (uniqueSources.length < 1) {
    reasons.push('no verified source found');
  }

  const mergedBook = {
    ...primary,
    isbn: isbn13 || primary.isbn || '',
    source: uniqueSources.join('+') || primary.source || 'unknown',
    verification_candidates: candidates,
  };

  return {
    ok: reasons.length === 0,
    book: reasons.length === 0 ? mergedBook : null,
    reasons,
    verification: {
      isbn13: isbn13 || null,
      matched_sources: uniqueSources.length,
      title_consistent: titleConsistent,
      author_consistent: authorConsistent,
    },
  };
}

module.exports = {
  verifyBookSources,
  normalizeText,
  normalizeAuthor,
  extractIsbn13,
};
