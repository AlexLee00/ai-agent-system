'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildGeneralRetryOptions,
  shouldAdvanceContentTracker,
} = require('../lib/category-rotation.ts');

describe('manual general republish', () => {
  test('enables tracker preservation at the retry entry point', () => {
    expect(buildGeneralRetryOptions({
      bookReviewTitleCandidate: '교체 제목',
      preserveContentTracker: false,
    })).toEqual({
      bookReviewTitleCandidate: '교체 제목',
      preserveContentTracker: true,
    });
  });

  test('preserves the content rotation after creating a replacement post', () => {
    expect(shouldAdvanceContentTracker({
      dryRun: false,
      published: { postId: 323, reused: false },
      preserveContentTracker: true,
    })).toBe(false);
  });

  test('preserves the content rotation when replacement generation is skipped', () => {
    expect(shouldAdvanceContentTracker({
      dryRun: false,
      published: null,
      preserveContentTracker: true,
    })).toBe(false);
  });

  test('keeps normal daily advancement unchanged', () => {
    expect(shouldAdvanceContentTracker({
      dryRun: false,
      published: { postId: 323, reused: false },
      preserveContentTracker: false,
    })).toBe(true);
  });

  test('does not mark a replacement book done when the publisher reused an existing post', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../lib/blo.ts'), 'utf8');
    expect(source).toMatch(
      /context\.category === '도서리뷰'\s*&& context\.book_info\s*&& !options\.dryRun\s*&& !published\?\.reused/,
    );
  });
});
