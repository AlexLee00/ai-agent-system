# 워커팀 — Claude Code 컨텍스트

## 팀 구조
워커(팀장) → 웹 대시보드(Next.js :3000) + 리드(task runner)
           → AI 피드백 시스템 (ai-feedback-core/store/rag 893줄)

## 핵심 파일
- web/server.js, web/app/dashboard/page.js
- src/worker-lead.js, lib/ai-policy.js, lib/runtime-config.js
- lib/llm-api-monitoring.js

## 현재 상태: 기본 운영 중, SaaS 본격 개발 대기 (Tier 3)
