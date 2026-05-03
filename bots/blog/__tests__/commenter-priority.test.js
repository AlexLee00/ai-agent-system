'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

const {
  prioritizePendingComments,
} = require(
  path.join(env.PROJECT_ROOT, 'bots/blog/lib/commenter.ts')
);

describe('blog commenter pending priority', () => {
  test('recoverable requeue comments are drained before fresh pending comments', () => {
    const ordered = prioritizePendingComments([
      {
        id: 200,
        status: 'pending',
        detected_at: '2026-05-03T03:36:10.184Z',
        meta: {},
      },
      {
        id: 1732,
        status: 'pending',
        detected_at: '2026-04-15T03:00:09.017Z',
        meta: {
          phase: 'recoverable_requeue',
          previous_error: 'reply_button_not_found:...',
        },
      },
      {
        id: 2284,
        status: 'pending',
        detected_at: '2026-05-03T03:40:10.184Z',
        meta: {
          phase: 'recoverable_requeue',
          previous_error: 'reply_process_timeout:240000',
        },
      },
    ], 3);

    expect(ordered.map((row) => row.id)).toEqual([1732, 2284, 200]);
  });
});
