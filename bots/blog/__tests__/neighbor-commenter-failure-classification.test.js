'use strict';

const {
  isRecoverableNeighborCommentFailure,
  isTransientBrowserNavigationError,
} = require('../lib/commenter.ts');

describe('neighbor commenter failure classification', () => {
  test('treats Naver navigation and browser transient failures as recoverable skips', () => {
    const errors = [
      new Error('net::ERR_NAME_NOT_RESOLVED at https://section.blog.naver.com/connect/ViewMoreBuddyPosts.naver'),
      new Error('fetch failed'),
      new Error('detached Frame'),
      new Error('neighbor_comment_process_timeout:180000'),
    ];

    for (const error of errors) {
      expect(isRecoverableNeighborCommentFailure(error)).toBe(true);
    }
  });

  test('keeps non-transient validation failures as hard failures', () => {
    expect(isRecoverableNeighborCommentFailure(new Error('neighbor_comment_validation_failed'))).toBe(false);
    expect(isTransientBrowserNavigationError(new Error('permission denied'))).toBe(false);
  });
});
