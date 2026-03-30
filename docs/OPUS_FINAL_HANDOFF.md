# Opus 세션 인수인계 — Chronos MLX 착수 + 전략 문서 업데이트 (2026-03-30)

> 작성일: 2026-03-30
> 모델: Claude Opus 4.6 (메티)
> 머신: 맥 스튜디오(OPS) — Desktop Commander 연결

---

## 현재 진행 중

### OPS 코덱스: Chronos Phase A — MLX 설치 (진행 중)

```
✅ Ollama 제거 완료
✅ MLX v0.31.1 + mlx-lm 설치
✅ 모델 다운로드 완료:
   - mlx-community/Qwen2.5-7B-Instruct-4bit (~4GB)
   - mlx-community/DeepSeek-R1-Distill-Qwen-32B-4bit (~18GB)
❌ MLX 서버 (mlx-openai-server) 실행 대기
❌ launchd 등록 (ai.mlx.server) 대기
프롬프트: docs/CODEX_CHRONOS_PHASE_A_OPS.md (270줄)
```

---

## 다음 작업 순서

```
1. OPS 코덱스 완료 대기 → 메티 검증
   - MLX 서버 동작: curl http://localhost:11434/v1/models
   - launchd 등록: launchctl list | grep mlx
   - DEV 접근: curl http://REDACTED_TAILSCALE_IP:11434/v1/models

2. DEV 코덱스 전달 (OPS 완료 후)
   프롬프트: docs/CODEX_CHRONOS_PHASE_A_DEV.md (194줄)
   → local-llm-client.js (packages/core/lib/ 공용)
   → ohlcv-fetcher.js + ta-indicators.js
   → chronos.js Layer 1~3 확장
   → env.js LOCAL_LLM_BASE_URL 추가

3. 블로팀 P1~P5 코덱스 프롬프트 작성

4. 이후: Shadow→Confirmation, DCA, OpenClaw
```

---

## 핵심 아키텍처 결정 (확정)

```
[DECISION] Ollama→MLX 전환 (20~50% 빠름, Apple 네이티브, arXiv 2511.05502)
[DECISION] local-llm-client.js → packages/core/lib/ (공용, hub-client와 동급)
[DECISION] MLX Tailscale 직접 접근 (Hub 경유 안 함, 장시간 응답)
[DECISION] env.js LOCAL_LLM_BASE_URL: ops=localhost:11434, dev=REDACTED_TAILSCALE_IP:11434
[DECISION] deepseek on_demand: true (36GB 메모리 보호, 5분 미사용 시 언로드)
[DECISION] mlx-openai-server 사용 (OpenAI /v1/chat/completions 호환)
[DECISION] Kimi K2/K2.5: 성능 우수하나 최소 128GB 필요 → 36GB에서 불가
```

---

## 참조 파일

```
전략: docs/STRATEGY_SESSION_PROMPT.md (227줄, 업데이트 완료)
인수인계: 이 파일
역할: docs/ROLE_PRINCIPLES.md

루나팀:
  docs/CODEX_CHRONOS_PHASE_A_OPS.md (270줄) — MLX 인프라
  docs/CODEX_CHRONOS_PHASE_A_DEV.md (194줄) — Chronos Layer 1~3
  docs/CODEX_LUNA_ROUNDSELL_FIX.md (136줄) — ✅ 완료

블로팀:
  docs/BLOG_DEEP_ANALYSIS_2026-03-30.md (245줄) — 딥 분석
  docs/BLOG_TEAM_STRATEGY_2026-03-30.md (223줄) — 전략 재설계
```
