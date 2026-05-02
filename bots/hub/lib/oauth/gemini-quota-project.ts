const QUOTA_PROJECT_ENV_NAMES = [
  'GEMINI_OAUTH_PROJECT_ID',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
];

function isEnabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function resolveGeminiQuotaProject(record = null, extra = null) {
  return String(
    process.env.GEMINI_OAUTH_PROJECT_ID
      || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
      || extra?.quota_project_id
      || extra?.project_id
      || record?.metadata?.quota_project_id
      || record?.metadata?.project_id
      || record?.token?.quota_project_id
      || record?.token?.project_id
      || '',
  ).trim();
}

function geminiCliQuotaProjectRequired(env = process.env) {
  return isEnabled(env.HUB_GEMINI_CLI_REQUIRE_PROJECT)
    || isEnabled(env.HUB_GEMINI_CLI_REQUIRE_QUOTA_PROJECT)
    || isEnabled(env.HUB_OAUTH_OPS_REQUIRE_GEMINI_QUOTA_PROJECT);
}

function geminiDirectQuotaProjectRequired(requiredByTeam) {
  return Boolean(requiredByTeam);
}

function geminiQuotaProjectStatus(options) {
  const provider = String(options.provider || '').trim();
  const configured = Boolean(options.configured);
  const requiredByTeam = Boolean(options.requiredByTeam);
  const requireProject = Boolean(options.requireProject);
  const required = provider === 'gemini-cli-oauth'
    ? requireProject
    : geminiDirectQuotaProjectRequired(requiredByTeam);

  if (configured) {
    return {
      configured: true,
      required,
      status: 'configured',
      reason: required ? 'quota_project_configured' : 'quota_project_configured_optional',
    };
  }

  return {
    configured: false,
    required,
    status: required ? 'required_missing' : 'optional_missing',
    reason: required
      ? 'quota_project_required_for_direct_gemini_or_strict_cli'
      : 'gemini_cli_quota_project_optional_by_default',
  };
}

module.exports = {
  QUOTA_PROJECT_ENV_NAMES,
  geminiCliQuotaProjectRequired,
  geminiDirectQuotaProjectRequired,
  geminiQuotaProjectStatus,
  resolveGeminiQuotaProject,
};
