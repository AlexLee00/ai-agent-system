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
  critical?: boolean;  // critical chain: 즉시 fallback, local 제외
  [key: string]: RuntimeProfileValue;
};

type TeamProfiles = Record<string, RuntimeProfile>;

const LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_BASE_URL = process.env.LOCAL_LLM_CHAT_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11435';
// Current deployed routes. These are intentionally separated from "latest official"
// model families so runtime profiles reflect live ops first.
const LOCAL_FAST_ROUTE = 'local/qwen2.5-7b';
const GROQ_SCOUT_ROUTE = 'groq/llama-3.1-8b-instant';
const GROQ_VERSATILE_ROUTE = 'groq/llama-3.3-70b-versatile';
const LOCAL_FAST_MODEL = 'qwen2.5-7b';

export const PROFILES: Record<string, TeamProfiles> = {
  "blog": {
    "default": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        LOCAL_FAST_ROUTE,
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "writer": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        LOCAL_FAST_ROUTE,
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "social": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4-mini",
        GROQ_SCOUT_ROUTE
      ],
      "fallback_routes": [
        "claude-code/sonnet"
      ]
    },
    "curriculum": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_VERSATILE_ROUTE
      ]
    },
    "image-local": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "local_image": true,
      "engine": "comfyui",
      "base_url": "http://127.0.0.1:8188",
      "checkpoint_name": "sd_xl_base_1.0.safetensors",
      "workflow_template_path": "/Users/alexlee/projects/ai-agent-system/bots/blog/config/comfyui-workflow-template.json",
      "timeout_ms": 300000,
      "poll_ms": 1500,
      "max_retries": 3
    },
    "gemma-topic": {
      "openclaw_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/blog-writer.settings.json",
      "provider": "local",
      "base_url": "http://127.0.0.1:11434",
      "model": LOCAL_FAST_MODEL,
      "timeout_ms": 10000,
      "max_tokens": 200,
      "temperature": 0.8
    }
  },
  "luna": {
    "default": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "analyst": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "validator": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "commander": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE
      ]
    },
    // 🔴 CRITICAL — 실시간 매매 판단 경로, local 제외, 즉시 fallback
    "exit_decision": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "primary_routes": [
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_VERSATILE_ROUTE
      ],
      "timeout_ms": 10_000,
      "critical": true
    },
    "portfolio_decision": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "primary_routes": [
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_VERSATILE_ROUTE
      ],
      "timeout_ms": 10_000,
      "critical": true
    },
    "decision_rationale": {
      "openclaw_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/luna-ops.settings.json",
      "primary_routes": [
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_VERSATILE_ROUTE,
        LOCAL_FAST_ROUTE
      ],
      "critical": false
    }
  },
  "darwin": {
    "default": {
      "openclaw_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/darwin-research.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "research": {
      "openclaw_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/darwin-research.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "synthesis": {
      "openclaw_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/darwin-research.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "review": {
      "openclaw_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/darwin-research.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE
      ]
    }
  },
  "justin": {
    "default": {
      "openclaw_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/justin-legal.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "citation": {
      "openclaw_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/justin-legal.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "analysis": {
      "openclaw_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/justin-legal.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE
      ]
    },
    "opinion": {
      "openclaw_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/justin-legal.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    }
  },
  "sigma": {
    "default": {
      "openclaw_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/sigma-data.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai-oauth/gpt-5.4",
        LOCAL_FAST_ROUTE
      ]
    },
    "quality": {
      "openclaw_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/sigma-data.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "experiment": {
      "openclaw_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/sigma-data.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "analysis": {
      "openclaw_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/sigma-data.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    }
  },
  "claude": {
    "default": {
      "openclaw_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/claude-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai-oauth/gpt-5.4",
        LOCAL_FAST_ROUTE
      ]
    },
    "reporting": {
      "openclaw_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/claude-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "triage": {
      "openclaw_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/claude-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "lead": {
      "openclaw_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/claude-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    }
  },
  "orchestrator": {
    "default": {
      "openclaw_agent": "jay-orchestrator",
      "claude_code_name": "jay-orchestrator",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/jay-orchestrator.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "intent": {
      "openclaw_agent": "jay-orchestrator",
      "claude_code_name": "jay-orchestrator",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/jay-orchestrator.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE
      ]
    },
    "fallback": {
      "openclaw_agent": "jay-orchestrator",
      "claude_code_name": "jay-orchestrator",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/jay-orchestrator.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        GROQ_SCOUT_ROUTE
      ],
      "fallback_routes": [
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "gemma-insight": {
      "openclaw_agent": "jay-orchestrator",
      "claude_code_name": "jay-orchestrator",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/jay-orchestrator.settings.json",
      "provider": "local",
      "base_url": "http://127.0.0.1:11434",
      "model": LOCAL_FAST_MODEL,
      "timeout_ms": 10000,
      "max_tokens": 300,
      "temperature": 0.7
    }
  },
  "ska": {
    "default": {
      "openclaw_agent": "ska-ops",
      "claude_code_name": "ska-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/ska-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE,
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "gemma-insight": {
      "openclaw_agent": "ska-ops",
      "claude_code_name": "ska-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/ska-ops.settings.json",
      "provider": "local",
      "base_url": "http://127.0.0.1:11434",
      "model": "qwen2.5-7b",
      "timeout_ms": 10000,
      "max_tokens": 150,
      "temperature": 0.7
    },
    "monitoring": {
      "openclaw_agent": "ska-ops",
      "claude_code_name": "ska-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/ska-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "reporting": {
      "openclaw_agent": "ska-ops",
      "claude_code_name": "ska-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/ska-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    }
  },
  "worker": {
    "default": {
      "openclaw_agent": "worker-ops",
      "claude_code_name": "worker-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/worker-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai/gpt-4o-mini",
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "assistant": {
      "openclaw_agent": "worker-ops",
      "claude_code_name": "worker-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/worker-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai/gpt-4o-mini",
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "intake": {
      "openclaw_agent": "worker-ops",
      "claude_code_name": "worker-ops",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/worker-ops.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        GROQ_SCOUT_ROUTE
      ],
      "fallback_routes": [
        "openai/gpt-4o-mini"
      ]
    }
  },
  "video": {
    "default": {
      "openclaw_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/video-edi.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE,
        "google-gemini-cli/gemini-2.5-flash"
      ]
    },
    "editing": {
      "openclaw_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/video-edi.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "analysis": {
      "openclaw_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/video-edi.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        LOCAL_FAST_ROUTE
      ]
    },
    "stt": {
      "openclaw_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/video-edi.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai/whisper-1"
      ],
      "fallback_routes": [],
      "direct_provider": "openai",
      "direct_model": "whisper-1",
      "direct_endpoint": "https://api.openai.com/v1/audio/transcriptions"
    },
    "review": {
      "openclaw_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": "/Users/alexlee/.openclaw/.claude/video-edi.settings.json",
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        "google-gemini-cli/gemini-2.5-flash"
      ]
    }
  }
};

for (const teamProfiles of Object.values(PROFILES)) {
  for (const profile of Object.values(teamProfiles)) {
    if (profile?.local_llm_base_url === LOCAL_LLM_BASE_URL) {
      profile.local_llm_base_url = OLLAMA_BASE_URL;
    }
  }
}

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
