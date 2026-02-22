# 🤖 AI Agent System

맥미니 M4 Pro 기반 멀티 에이전트 AI 봇 시스템

## 구조

```
ai-agent-system/
├── packages/
│   ├── core/              # 공통 타입, 유틸, 인터페이스
│   └── playwright-utils/  # 브라우저 자동화 공통 모듈
├── bots/
│   ├── orchestrator/      # 🤖 메인봇 (팀장)
│   ├── reservation/       # 📅 예약관리봇
│   ├── secretary/         # 🗓️ 개인비서봇
│   ├── business/          # 💼 업무봇
│   ├── academic/          # 🎓 학술보조봇
│   └── legal/             # ⚖️ 판례봇
├── apps/
│   ├── gateway/           # OpenClaw 연동
│   └── dashboard/         # 모니터링 대시보드
└── docs/                  # 설계 문서
```

## 봇별 진행 현황

| 봇 | 모델 | 진행률 |
|----|------|--------|
| 🤖 메인봇 (오케스트레이터) | qwen2.5:32b | ⏳ Phase 3 |
| 📅 예약관리봇 | qwen2.5:7b | 🔄 85% |
| 🗓️ 개인비서봇 | qwen2.5:14b | ⏳ Phase 3 |
| 💼 업무봇 | qwen2.5:32b | ⏳ Phase 3 |
| 🎓 학술보조봇 | Deepseek-r1:32b | ⏳ Phase 4 |
| ⚖️ 판례봇 | Deepseek-r1:32b | ⏳ Phase 4 |

## 구축 단계

- **Phase 1** (현재): OpenClaw + API 연결, 예약봇 개발
- **Phase 2**: 맥미니 구매 후 Ollama / n8n / Tailscale 세팅
- **Phase 3**: 예약봇 이전 + 비서봇 / 업무봇 / 메인봇 구축
- **Phase 4**: 학술봇 / 판례봇 구축

## 상세 설계서

[SYSTEM_DESIGN.md](./docs/SYSTEM_DESIGN.md)
