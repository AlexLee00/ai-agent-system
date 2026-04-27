type RuntimeProfileValue = string | number | boolean | string[] | undefined;

type RuntimeProfile = {
  runtime_agent?: string;
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
// Current deployed routes. These are intentionally separated from "latest official"
// model families so runtime profiles reflect live ops first.
const GROQ_SCOUT_ROUTE = 'groq/llama-3.1-8b-instant';
const GROQ_VERSATILE_ROUTE = 'groq/llama-3.3-70b-versatile';
const OPENAI_FAST_ROUTE = 'openai-oauth/gpt-5.4-mini';
const GEMINI_OAUTH_FLASH_LITE_ROUTE = 'gemini-oauth/gemini-2.5-flash-lite';
const GEMINI_OAUTH_FLASH_ROUTE = 'gemini-oauth/gemini-2.5-flash';
const GEMINI_CODEASSIST_PRO_ROUTE = 'gemini-codeassist-oauth/gemini-2.5-pro';
const GEMINI_CLI_FLASH_LITE_ROUTE = 'gemini-cli-oauth/gemini-2.5-flash-lite';
const GEMINI_CLI_FLASH_ROUTE = 'gemini-cli-oauth/gemini-2.5-flash';
const GEMINI_CLI_PRO_ROUTE = 'gemini-cli-oauth/gemini-2.5-pro';
const HUB_CLAUDE_CODE_SETTINGS_DIR = `${process.env.PROJECT_ROOT || '/Users/alexlee/projects/ai-agent-system'}/bots/hub/config/claude-code`;
const CLAUDE_CODE_SETTINGS: Record<string, string> = {
  'blog-writer': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/blog-writer.settings.json`,
  'claude-ops': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/claude-ops.settings.json`,
  'darwin-research': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/darwin-research.settings.json`,
  'justin-legal': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/justin-legal.settings.json`,
  'luna-ops': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/luna-ops.settings.json`,
  'sigma-data': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/sigma-data.settings.json`,
  'video-edi': `${HUB_CLAUDE_CODE_SETTINGS_DIR}/video-edi.settings.json`,
};

export const PROFILES: Record<string, TeamProfiles> = {
  "blog": {
    "default": {
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "writer": {
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "social": {
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
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
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
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
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
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
      "runtime_agent": "blog-writer",
      "claude_code_name": "blog-writer",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["blog-writer"],
      "provider": "groq",
      "model": "llama-3.1-8b-instant",
      "timeout_ms": 10000,
      "max_tokens": 200,
      "temperature": 0.8
    }
  },
  "luna": {
    "default": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "analyst": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "validator": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "commander": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
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
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "primary_routes": [
        GROQ_VERSATILE_ROUTE
      ],
      "fallback_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4-mini"
      ],
      "timeout_ms": 10_000,
      "critical": true
    },
    "portfolio_decision": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "primary_routes": [
        GROQ_VERSATILE_ROUTE
      ],
      "fallback_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4-mini"
      ],
      "timeout_ms": 10_000,
      "critical": true
    },
    "decision_rationale": {
      "runtime_agent": "luna-ops",
      "claude_code_name": "luna-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["luna-ops"],
      "primary_routes": [
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_VERSATILE_ROUTE,
        OPENAI_FAST_ROUTE
      ],
      "critical": false
    }
  },
  "darwin": {
    "default": {
      "runtime_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["darwin-research"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE,
        GEMINI_OAUTH_FLASH_ROUTE
      ]
    },
    "research": {
      "runtime_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["darwin-research"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE,
        GEMINI_OAUTH_FLASH_ROUTE
      ]
    },
    "synthesis": {
      "runtime_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["darwin-research"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE,
        GEMINI_OAUTH_FLASH_ROUTE
      ]
    },
    "review": {
      "runtime_agent": "darwin-research",
      "claude_code_name": "darwin-research",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["darwin-research"],
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
      "runtime_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["justin-legal"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "citation": {
      "runtime_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["justin-legal"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "analysis": {
      "runtime_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["justin-legal"],
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
      "runtime_agent": "justin-legal",
      "claude_code_name": "justin-legal",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["justin-legal"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    }
  },
  "sigma": {
    "default": {
      "runtime_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["sigma-data"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai-oauth/gpt-5.4",
        OPENAI_FAST_ROUTE
      ]
    },
    "quality": {
      "runtime_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["sigma-data"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "experiment": {
      "runtime_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["sigma-data"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "analysis": {
      "runtime_agent": "sigma-data",
      "claude_code_name": "sigma-data",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["sigma-data"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    }
  },
  "claude": {
    "default": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai-oauth/gpt-5.4",
        OPENAI_FAST_ROUTE
      ]
    },
    "reporting": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "triage": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "lead": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    }
  },
  "orchestrator": {
    "default": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "intent": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
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
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        GROQ_SCOUT_ROUTE
      ],
      "fallback_routes": [
        GEMINI_OAUTH_FLASH_ROUTE
      ]
    },
    "summary": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GEMINI_CLI_FLASH_ROUTE
      ],
      "fallback_routes": [
        OPENAI_FAST_ROUTE,
        "claude-code/sonnet"
      ]
    },
    "steward": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GEMINI_CLI_FLASH_ROUTE
      ],
      "fallback_routes": [
        GEMINI_CLI_FLASH_LITE_ROUTE,
        OPENAI_FAST_ROUTE
      ],
      "timeout_ms": 18000,
      "max_tokens": 320,
      "temperature": 0.2
    },
    "steward-digest": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GEMINI_CLI_FLASH_LITE_ROUTE
      ],
      "fallback_routes": [
        GEMINI_CLI_FLASH_ROUTE
      ],
      "timeout_ms": 12000,
      "max_tokens": 220,
      "temperature": 0.1
    },
    "steward-incident": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GEMINI_CLI_FLASH_ROUTE
      ],
      "fallback_routes": [
        GEMINI_CLI_FLASH_LITE_ROUTE,
        "claude-code/sonnet"
      ],
      "timeout_ms": 25000,
      "max_tokens": 700,
      "temperature": 0.2
    },
    "steward-pro-canary": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GEMINI_CLI_PRO_ROUTE
      ],
      "fallback_routes": [
        GEMINI_CODEASSIST_PRO_ROUTE
      ],
      "timeout_ms": 60000,
      "max_tokens": 128,
      "temperature": 0.2
    },
    "gemma-insight": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "provider": "groq",
      "model": "llama-3.1-8b-instant",
      "timeout_ms": 10000,
      "max_tokens": 300,
      "temperature": 0.7
    }
  },
  "ska": {
    "default": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE,
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "gemma-insight": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "provider": "groq",
      "model": "llama-3.1-8b-instant",
      "timeout_ms": 10000,
      "max_tokens": 150,
      "temperature": 0.7
    },
    "monitoring": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "reporting": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    }
  },
  "worker": {
    "default": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai/gpt-4o-mini",
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "assistant": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai/gpt-4o-mini",
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "intake": {
      "runtime_agent": "claude-ops",
      "claude_code_name": "claude-ops",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["claude-ops"],
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
  "editor": {
    "default": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        GROQ_SCOUT_ROUTE,
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        "openai-oauth/gpt-5.4",
        OPENAI_FAST_ROUTE
      ]
    },
    "review": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    }
  },
  "video": {
    "default": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE,
        "gemini-oauth/gemini-2.5-flash"
      ]
    },
    "editing": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "analysis": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "openai-oauth/gpt-5.4",
        "claude-code/sonnet"
      ],
      "fallback_routes": [
        GROQ_SCOUT_ROUTE,
        OPENAI_FAST_ROUTE
      ]
    },
    "stt": {
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
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
      "runtime_agent": "video-edi",
      "claude_code_name": "video-edi",
      "claude_code_settings": CLAUDE_CODE_SETTINGS["video-edi"],
      "local_llm_base_url": "http://127.0.0.1:11434",
      "primary_routes": [
        "claude-code/sonnet",
        "openai-oauth/gpt-5.4"
      ],
      "fallback_routes": [
        "gemini-oauth/gemini-2.5-flash"
      ]
    }
  }
};

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
};
