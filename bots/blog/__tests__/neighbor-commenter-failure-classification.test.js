'use strict';

const {
  isDirectReplyUiError,
  isRecoverableNeighborCommentFailure,
  shouldDeferRecoverableReplyRequeue,
  isTransientBrowserNavigationError,
  validateNeighborCommentWithCandidate,
  _testOnly,
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

  test('rejects first-visit phrasing when target has prior neighbor comment history', () => {
    const candidate = {
      source_type: 'commenter_network',
      priorNeighborInteractionCount: 2,
    };
    const summary = '돌곶이역점 본죽 신짬뽕죽으로 속을 달랜 후기';

    const invalid = validateNeighborCommentWithCandidate(
      '처음 들렀는데 돌곶이역점 본죽 신짬뽕죽 흐름이 현실감 있어서 바로 읽게 됐네요. 점심이 안 내려가던 장면까지 자연스럽게 이어졌습니다.',
      summary,
      candidate,
    );
    const valid = validateNeighborCommentWithCandidate(
      '돌곶이역점 본죽으로 신짬뽕죽을 고른 흐름이 현실감 있어서 바로 읽게 됐네요. 퇴근길에 속을 달랜 장면도 자연스럽게 와닿았습니다.',
      summary,
      candidate,
    );

    expect(invalid).toEqual({ ok: false, reason: 'first_visit_phrase_on_repeat_target' });
    expect(valid).toEqual({ ok: true });
    expect(validateNeighborCommentWithCandidate(
      '방문해보니 돌곶이역점 본죽 신짬뽕죽 이야기가 현실감 있게 이어져서 바로 읽게 됐네요. 속을 달랜 흐름까지 구체적이었습니다.',
      summary,
      candidate,
    )).toEqual({ ok: false, reason: 'first_visit_phrase_on_repeat_target' });
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

describe('neighbor commenter managed browser connection', () => {
  test('skips stale runtime ws endpoints and connects to the next candidate', async () => {
    const attempts = [];
    const browser = { id: 'fresh-managed-browser' };

    const result = await _testOnly.connectBrowser(true, {
      readWsEndpoints: () => ['ws://stale:1', 'ws://fresh:2'],
      connect: async ({ browserWSEndpoint }) => {
        attempts.push(browserWSEndpoint);
        if (browserWSEndpoint === 'ws://stale:1') throw new Error('socket closed');
        return browser;
      },
      fetchManagedBrowserWsEndpoint: async () => '',
    });

    expect(result).toEqual({ browser, managed: true, mode: 'connect-ws-file' });
    expect(attempts).toEqual(['ws://stale:1', 'ws://fresh:2']);
  });
});
