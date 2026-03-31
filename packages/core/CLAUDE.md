# 공용 계층 — Claude Code 컨텍스트

## packages/core/lib/ 핵심 모듈
- env.js — DEV/OPS 환경 분기, API 키 로딩
- pg-pool.js — PostgreSQL 연결 (자동 재연결, exponential backoff)
- hub-client.js — Hub API 클라이언트 (secrets/errors/pg-query)
- local-llm-client.js — MLX 로컬 LLM (OpenAI 호환, 공용)
- kst.js — 한국 시간 유틸리티 (모든 팀 필수 사용)
- health-provider.js — 공용 헬스 체크
- reporting-hub.js — 공용 알림/리포트
- ai-feedback-core.js — AI 피드백 루프
- rag.js — pgvector RAG
- telegram-sender.js — 텔레그램 발송 (rate limit 준수)

## 패턴
- 모든 함수 실패 시 null 반환 (throw 금지, 서비스 중단 방지)
- AbortController + 타임아웃 패턴 (hub-client, local-llm-client)
- 환경 분기: env.js에서 MODE(dev/ops) 기반 URL 자동 전환

## 가이드: docs/guides/ (coding, db, llm, ops, runtime-config)
