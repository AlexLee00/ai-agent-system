'use strict';

const {
  classifyEngagementFailure,
  isReplyEditorReadyResult,
  summarizeEngagementFailure,
} = require('../lib/engagement-failure.ts');

describe('engagement failure classification', () => {
  test('classifies reply process timeouts as UI failures', () => {
    expect(classifyEngagementFailure({ error: 'reply_process_timeout:360000' })).toBe('ui');
  });

  test('uses the reply activation stage before generic timeout wording', () => {
    expect(classifyEngagementFailure({
      error: 'reply_diagnose_timeout:10000',
      stage: 'activate_reply_mode',
    })).toBe('ui');
  });

  test('keeps provider and browser failures in their own categories', () => {
    expect(classifyEngagementFailure({ error: 'hub_llm_call_failed:429' })).toBe('llm');
    expect(classifyEngagementFailure({ error: 'browser navigation timeout' })).toBe('browser');
  });

  test('summarizes verbose UI diagnostics without leaking snapshot paths', () => {
    expect(summarizeEngagementFailure({
      error: 'reply_button_not_found: snapshotPrefix=/tmp/private/debug.json, detail=missing',
    })).toContain('snapshotPrefix');
    expect(summarizeEngagementFailure({
      error: 'reply_button_not_found: snapshotPrefix=/tmp/private/debug.json, detail=missing',
    })).not.toContain('/tmp/private');
  });

  test('requires both the reply editor and submit control for a ready dry-run', () => {
    const ready = {
      ok: true,
      dryRun: true,
      stage: 'reply_editor_ready',
      editorSelector: '[data-blog-commenter-editor="true"]',
      submitReady: true,
    };

    expect(isReplyEditorReadyResult(ready)).toBe(true);
    expect(isReplyEditorReadyResult({ ...ready, submitReady: false })).toBe(false);
    expect(isReplyEditorReadyResult({ ...ready, editorSelector: '' })).toBe(false);
    expect(isReplyEditorReadyResult({ ...ready, dryRun: false })).toBe(false);
  });
});
