// @ts-nocheck
'use strict';

const UI_MODES = new Set(['prompt_only', 'prompt_plus_dashboard', 'full_master_console']);
const LLM_MODES = new Set(['off', 'assist', 'full']);
const CONFIRMATION_MODES = new Set(['required', 'optional']);

function normalizeUiMode(value, fallback = 'prompt_only') {
  return UI_MODES.has(value) ? value : fallback;
}

function normalizeLlmMode(value, fallback = 'assist') {
  return LLM_MODES.has(value) ? value : fallback;
}

function normalizeConfirmationMode(value, fallback = 'required') {
  return CONFIRMATION_MODES.has(value) ? value : fallback;
}

function buildMasterPolicy(user = {}) {
  return {
    ui_mode: normalizeUiMode(user.ai_ui_mode_override, 'full_master_console'),
    llm_mode: normalizeLlmMode(user.ai_llm_mode_override, 'full'),
    confirmation_mode: normalizeConfirmationMode(user.ai_confirmation_mode_override, 'optional'),
    can_toggle_llm: true,
    role_profile: 'master',
    source: 'master_fixed',
  };
}

function resolveAiPolicy({ user = {}, company = null } = {}) {
  if (user.role === 'master') return buildMasterPolicy(user);

  const companyPolicy = company || {};
  const baseUiMode = user.role === 'admin'
    ? normalizeUiMode(companyPolicy.ai_admin_ui_mode, 'prompt_plus_dashboard')
    : normalizeUiMode(companyPolicy.ai_member_ui_mode, 'prompt_only');
  const baseLlmMode = user.role === 'admin'
    ? normalizeLlmMode(companyPolicy.ai_admin_llm_mode, 'assist')
    : normalizeLlmMode(companyPolicy.ai_member_llm_mode, 'assist');
  const baseConfirmationMode = normalizeConfirmationMode(companyPolicy.ai_confirmation_mode, 'required');

  const canToggleLlm = user.role === 'admin' && Boolean(companyPolicy.ai_allow_admin_llm_toggle);

  return {
    ui_mode: normalizeUiMode(user.ai_ui_mode_override, baseUiMode),
    llm_mode: normalizeLlmMode(user.ai_llm_mode_override, baseLlmMode),
    confirmation_mode: normalizeConfirmationMode(user.ai_confirmation_mode_override, baseConfirmationMode),
    can_toggle_llm: canToggleLlm || user.role === 'master',
    role_profile: user.role === 'admin' ? 'admin' : 'member',
    source: user.ai_ui_mode_override || user.ai_llm_mode_override || user.ai_confirmation_mode_override
      ? 'user_override'
      : 'company_default',
    company_policy: {
      member_ui_mode: normalizeUiMode(companyPolicy.ai_member_ui_mode, 'prompt_only'),
      admin_ui_mode: normalizeUiMode(companyPolicy.ai_admin_ui_mode, 'prompt_plus_dashboard'),
      member_llm_mode: normalizeLlmMode(companyPolicy.ai_member_llm_mode, 'assist'),
      admin_llm_mode: normalizeLlmMode(companyPolicy.ai_admin_llm_mode, 'assist'),
      confirmation_mode: baseConfirmationMode,
      allow_admin_llm_toggle: Boolean(companyPolicy.ai_allow_admin_llm_toggle),
    },
  };
}

function validateLlmModeForUser(user, company, nextMode) {
  const llmMode = normalizeLlmMode(nextMode, '');
  if (!llmMode) {
    return { ok: false, error: '허용되지 않는 LLM 모드입니다.' };
  }

  if (user.role === 'master') {
    return { ok: true, llmMode };
  }

  if (user.role !== 'admin') {
    return { ok: false, error: 'LLM 모드 변경 권한이 없습니다.' };
  }

  if (!company?.ai_allow_admin_llm_toggle) {
    return { ok: false, error: '이 업체는 관리자 LLM 토글이 비활성화되어 있습니다.' };
  }

  if (llmMode === 'full') {
    return { ok: false, error: '관리자는 full LLM 모드를 사용할 수 없습니다.' };
  }

  return { ok: true, llmMode };
}

module.exports = {
  UI_MODES,
  LLM_MODES,
  CONFIRMATION_MODES,
  normalizeUiMode,
  normalizeLlmMode,
  normalizeConfirmationMode,
  resolveAiPolicy,
  validateLlmModeForUser,
};
