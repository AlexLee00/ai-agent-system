<p align="center">
  <h1 align="center">🤖 AI Agent System</h1>
  <p align="center">
    <strong>A self-evolving multi-agent platform with 121 autonomous agents across 10 specialized teams</strong>
  </p>
  <p align="center">
    <a href="#architecture">Architecture</a> •
    <a href="#teams">Teams</a> •
    <a href="#features">Features</a> •
    <a href="#tech-stack">Tech Stack</a> •
    <a href="#getting-started">Getting Started</a>
  </p>
</p>

---

## What is this?

A **production-grade multi-agent AI platform** running 24/7 on Apple Silicon, orchestrating 121 autonomous agents that trade crypto, publish blogs, manage reservations, conduct research, and continuously improve themselves — all at **$0 API cost** using local LLMs.

```
10 Teams • 121 Agents • 76 launchd Services • 12 Telegram Topics
Node.js Monorepo • PostgreSQL + pgvector • MLX Local LLMs • $0 Cost
```


## ✨ Key Features

- **Self-Evolving System** — Agents autonomously research papers, propose improvements, and apply them to the codebase
- **Triple Feedback Loop** — L1: team self-learning → L2: cross-team analysis → L3: meta-feedback (the system optimizes its own optimization)
- **Dynamic Agent Hiring** — ε-greedy selection picks the best agent for each task based on historical performance
- **Autonomous Research (Darwin Team)** — Daily arXiv/HuggingFace scans → evaluate → propose → prototype → apply
- **RAG Knowledge Library** — pgvector-powered experience store with auto-labeling and Standing Orders promotion
- **Zero API Cost** — MLX local LLMs (Qwen 2.5 7B + DeepSeek R1 32B) handle all inference on-device
- **Competition System** — Agents compete for tasks; winners get higher hiring scores (MWF schedule)
- **Data Asset Pipeline** — 5-label system preparing all agent activity data for reusability and future exchange


<h2 id="architecture">🏗 Architecture</h2>

```
                        ┌─────────────────────┐
                        │    Master (Jay)      │
                        │  Strategy & Oversight│
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
     ┌────────┴────────┐  ┌───────┴───────┐  ┌─────────┴────────┐
     │   Hub (:7788)   │  │  OpenClaw CLI │  │  Telegram (12ch) │
     │  Secrets/PG/API │  │  Webhooks/SO  │  │  Alerts/Reports  │
     └────────┬────────┘  └───────┬───────┘  └─────────┬────────┘
              │                   │                     │
  ┌───────────┼───────────────────┼─────────────────────┼──────────┐
  │           │                   │                     │          │
  ▼           ▼                   ▼                     ▼          ▼
┌─────┐  ┌────────┐  ┌────────┐  ┌───────┐  ┌───────┐  ┌────────┐
│Luna │  │  Blog  │  │Darwin  │  │Claude │  │ Ska   │  │Worker  │
│Trade│  │Publish │  │Research│  │Monitor│  │Reserve│  │  SaaS  │
│ 13  │  │  12    │  │  15    │  │  10+  │  │  10+  │  │  10+   │
└─────┘  └────────┘  └────────┘  └───────┘  └───────┘  └────────┘
                        ┌────────┐  ┌────────┐  ┌────────┐
                        │Justin  │  │  Edi   │  │ Sigma  │
                        │Forensic│  │ Video  │  │  Data  │
                        │  10    │  │  10+   │  │  12    │
                        └────────┘  └────────┘  └────────┘
```


<h2 id="teams">👥 Teams & Agents (121 total)</h2>

| Team | Mission | Agents | Key Capabilities |
|------|---------|--------|-----------------|
| **Luna** | Crypto & stock trading | 13 | Multi-analyst debate (bull vs bear), autonomous execution, risk management, wallet reconciliation |
| **Blog** | Naver blog automation | 12 | Lecture/general series, SEO optimization, quality checking, performance-based writer selection |
| **Darwin** | Autonomous R&D | 15 | arXiv/HF daily scans, 9-domain searchers, auto-propose → prototype → apply pipeline |
| **Claude** | System monitoring | 10+ | Dexter (health checks), Doctor (auto-recovery), Steward (daily ops summary) |
| **Ska** | Study café management | 10+ | Naver reservation sync, kiosk monitoring, revenue forecasting, event collection |
| **Worker** | Business SaaS portal | 10+ | Next.js dashboard, task runner, chat agent, SQL analytics |
| **Justin** | Legal SW forensics | 10 | Case analysis, precedent search (KR/US/EU), expert report writing, quality review |
| **Edi** | Video auto-editing | 10+ | Timeline editing, scene analysis, narration, subtitle correction |
| **Sigma** | Platform intelligence | 12 | Triple feedback loop, hawk/dove/owl analysts, dynamic formation, data asset pipeline |
| **Jay** | Orchestration | — | Steward, mainbot (retired), event reminders, deploy automation |


## 🔄 Triple Feedback Loop

The system continuously improves through three layers of feedback:

| Layer | Scope | Frequency | Example |
|-------|-------|-----------|---------|
| **L1 — Team Self-Learning** | Each team optimizes its own performance | Real-time | Luna: trade → P&L → adjust strategy → next trade |
| **L2 — Sigma Cross-Team Analysis** | Sigma team analyzes all teams and provides feedback | Daily | "Blog writer X has 2x views → increase hiring score" |
| **L3 — Sigma Meta-Feedback** | Sigma evaluates its own analysis effectiveness | Weekly | "Hawk analyst feedback was 80% effective → increase hawk allocation" |


<h2 id="tech-stack">🛠 Tech Stack</h2>

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js 25 (monorepo) |
| **Database** | PostgreSQL 17 + pgvector (vector embeddings) |
| **Local LLMs** | MLX Server — Qwen 2.5 7B (fast), DeepSeek R1 32B (reasoning) |
| **Embeddings** | MLX Qwen3-Embedding-0.6B (1024-dim, fully local) |
| **Cloud LLMs** | Groq (free, fallback), OpenAI/Anthropic (selective) |
| **Hardware** | Mac Studio M4 Max 36GB (OPS) + MacBook Air M3 (DEV) |
| **Orchestration** | launchd (76 services), OpenClaw CLI, Hub API (:7788) |
| **Communication** | Telegram Bot API (12 topic channels) |
| **CI/CD** | GitHub Actions + deploy.sh (5-min cron) |
| **VPN** | Tailscale (DEV ↔ OPS secure tunnel) |


<h2 id="getting-started">🚀 Project Structure</h2>

```
ai-agent-system/
├── packages/core/           # Shared libraries (@ai-agent/core)
│   └── lib/
│       ├── hiring-contract.js    # Dynamic agent selection (ε-greedy)
│       ├── llm-fallback.js       # Multi-provider LLM with chain fallback
│       ├── openclaw-client.js    # Telegram alerts & Standing Orders
│       ├── pg-pool.js            # PostgreSQL connection pool
│       ├── agent-registry.js     # Agent CRUD & scoring
│       └── skills/               # Team-specific skill modules
├── bots/
│   ├── investment/          # Luna team (crypto/stock trading)
│   ├── blog/                # Blog team (Naver blog automation)
│   ├── orchestrator/        # Darwin, Sigma, Steward, schedulers
│   ├── claude/              # Claude team (monitoring, doctor)
│   ├── reservation/         # Ska team (study café)
│   ├── worker/              # Worker team (SaaS portal)
│   └── video/               # Edi team (video editing)
├── bots/hub/                # Hub API server (:7788)
├── docs/
│   ├── strategy/            # Strategic documents
│   ├── codex/               # Active implementation prompts
│   └── research/            # Papers, proposals, analyses
└── scripts/                 # Deploy, migrate, utilities
```

## 📊 System Stats

```
Agents:          121 (across 10 teams)
launchd Services: 76 (23 running continuously)
Telegram Topics:  12 (per-team routing)
Codex Archives:   77+ (completed implementation prompts)
Repository Size:  23 MB (optimized from 43 MB)
Monthly API Cost: $0 (fully local LLM inference)
```

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Built with ❤️ by <strong>Team Jay</strong> — A self-evolving multi-agent platform
</p>
