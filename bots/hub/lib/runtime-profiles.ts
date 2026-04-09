type RuntimeProfileValue = string | number | boolean | string[] | undefined;

type RuntimeProfile = {
  openclaw_agent?: string;
  claude_code_name?: string;
  claude_code_settings?: string;
  local_llm_base_url?: string;
  primary_routes?: string[];
  fallback_routes?: string[];
  provider?: string;
  base_url?: string;
  model?: string;
  timeout_ms?: number;
  max_tokens?: number;
  temperature?: number;
  local_image?: boolean;
  engine?: string;
  checkpoint_name?: string;
  workflow_template_path?: string;
  poll_ms?: number;
  max_retries?: number;
  direct_provider?: string;
  direct_model?: string;
  direct_endpoint?: string;
  [key: string]: RuntimeProfileValue;
};

type TeamProfiles = Record<string, RuntimeProfile>;

const LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11435';

export const PROFILES: Record<string, TeamProfiles> = require('./runtime-profiles.legacy.js').PROFILES;

export function selectRuntimeProfile(team: string | null | undefined, purpose = 'default'): RuntimeProfile | null {
  const normalizedTeam = String(team || '').trim().toLowerCase();
  const normalizedPurpose = String(purpose || 'default').trim().toLowerCase() || 'default';
  if (!normalizedTeam) return null;

  const teamProfiles = PROFILES[normalizedTeam];
  if (!teamProfiles) return null;

  return teamProfiles[normalizedPurpose] || teamProfiles.default || null;
}

export {
  LOCAL_LLM_BASE_URL,
  OLLAMA_BASE_URL,
};
