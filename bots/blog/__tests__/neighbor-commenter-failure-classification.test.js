'use strict';

const {
  isDirectReplyUiError,
  isRecoverableNeighborCommentFailure,
  shouldDeferRecoverableReplyRequeue,
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

describe('reply commenter failure classification', () => {
  test('treats reply process timeouts as recoverable UI skips', () => {
    const error = new Error('reply_process_timeout:240000');
    error.code = 'reply_process_timeout';

    expect(isDirectReplyUiError(error)).toBe(true);
  });

  test('keeps content validation failures as hard reply failures', () => {
    expect(isDirectReplyUiError(new Error('reply_validation_failed'))).toBe(false);
  });

  test('defers recent recoverable reply retries to avoid timeout loops', () => {
    const now = Date.parse('2026-05-23T01:45:00.000Z');
    const recent = {
      meta: {
        last_ui_error_at: '2026-05-23T01:44:00.000Z',
      },
    };
    const old = {
      meta: {
        last_ui_error_at: '2026-05-22T18:44:00.000Z',
      },
    };

    expect(shouldDeferRecoverableReplyRequeue(recent, now)).toBe(true);
    expect(shouldDeferRecoverableReplyRequeue(old, now)).toBe(false);
  });
});
