# 🤖 AI Agent System

맥미니 M4 Pro 기반 멀티 에이전트 AI 봇 시스템

## 현재 운영 현황

| 봇 | 모델 | 상태 |
|----|------|------|
| 📅 예약관리봇 (스카) | gemini-2.0-flash | ✅ OPS 실운영 중 |
| 🤖 메인봇 (오케스트레이터) | qwen2.5:32b | ⏳ Phase 3 |
| 🗓️ 개인비서봇 | qwen2.5:14b | ⏳ Phase 3 |
| 💼 업무봇 | qwen2.5:32b | ⏳ Phase 3 |
| 🎓 학술보조봇 | Deepseek-r1:32b | ⏳ Phase 4 |
| ⚖️ 판례봇 | Deepseek-r1:32b | ⏳ Phase 4 |

## 구조

```
ai-agent-system/
├── bots/
│   ├── registry.json          # 전체 봇 등록부
│   └── reservation/           # 📅 예약관리봇 (스카)
│       ├── context/           # 컨텍스트 소스 (git 관리)
│       │   ├── IDENTITY.md
│       │   ├── MEMORY.md
│       │   ├── DEV_SUMMARY.md
│       │   └── HANDOFF.md
│       └── src/               # 소스코드
├── scripts/
│   ├── deploy-context.js      # 봇 기억 배포/역동기화
│   └── nightly-sync.sh        # 자정 자동 보존
└── docs/
    └── SYSTEM_DESIGN.md       # 전체 설계서
```

## 컨텍스트 관리

봇들이 모델 교체 / 재시작 후에도 이전 기억을 이어받아 연속 작업 가능.

```bash
# 배포 (context/ → 봇 워크스페이스)
node scripts/deploy-context.js --bot=reservation

# 역동기화 (워크스페이스 → context/)
node scripts/deploy-context.js --bot=reservation --sync

# 전체 봇 배포
node scripts/deploy-context.js --all
```

## 구축 단계

- **Phase 1** ✅: OpenClaw + 예약봇 OPS 실운영 + RAG + 컨텍스트 관리
- **Phase 2** ⏳: 맥미니 구매 후 Ollama / n8n / Tailscale 세팅
- **Phase 3** ⏳: 예약봇 이전 + 비서봇 / 업무봇 / 메인봇 구축
- **Phase 4** ⏳: 학술봇 / 판례봇 구축

## 상세 설계서

[SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)
