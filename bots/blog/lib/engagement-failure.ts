// @ts-nocheck
'use strict';

function engagementFailureText(meta = {}) {
  return String(meta?.error || meta?.uiError || meta?.previous_error || '').trim();
}

function engagementFailureStage(meta = {}) {
  return String(
    meta?.stage
      || meta?.replyDiagnoseStage
      || meta?.phase
      || meta?.errorMeta?.stage
      || '',
  ).trim();
}

function classifyEngagementFailure(meta = {}) {
  const errorText = engagementFailureText(meta);
  const stage = engagementFailureStage(meta);
  if (!errorText) {
    if (meta?.correction_reason === 'reply_verification_false_positive') return 'verification';
    return 'unknown';
  }

  if (
    /^reply_(?:process|diagnose)_timeout(?::|$)/.test(errorText)
    || /^(?:activate_reply_mode|open_reply_editor|focus_reply_editor)/.test(stage)
    || errorText.includes('reply_mode_activation_timeout')
    || errorText.includes('reply_button_not_found')
    || errorText.includes('reply_submit_not_found')
    || errorText.includes('reply_submit_not_confirmed')
    || errorText.includes('comment_submit_not_confirmed')
    || errorText.includes('sympathy_button_not_found')
    || errorText.includes('reply_ui_unavailable')
    || errorText.includes('reply_editor_not_found')
  ) return 'ui';

  if (
    errorText.includes('ECONNREFUSED')
    || errorText.includes('__name is not defined')
    || errorText.toLowerCase().includes('browser')
    || errorText.includes('ws 연결 실패')
    || errorText.includes('detached Frame')
  ) return 'browser';

  if (
    errorText.includes('hub_llm_call_failed:')
    || errorText.includes('429')
    || errorText.includes('Claude Code')
    || errorText.includes('Groq')
    || errorText.includes('fetch failed')
  ) return 'llm';

  return 'unknown';
}

function summarizeEngagementFailure(meta = {}) {
  const raw = String(meta?.error || meta?.uiError || meta?.previous_error || meta?.message || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')
    .replace(/snapshotPrefix[^,}\]]*/gi, 'snapshotPrefix')
    .slice(0, 140);
}

function isReplyEditorReadyResult(result = {}) {
  return Boolean(
    result?.ok
    && result?.dryRun === true
    && result?.stage === 'reply_editor_ready'
    && result?.editorSelector
    && result?.submitReady === true,
  );
}

module.exports = {
  classifyEngagementFailure,
  summarizeEngagementFailure,
  isReplyEditorReadyResult,
};
