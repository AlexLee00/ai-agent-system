# Opus 세션 인수인계 — Hub Secrets Store + LLM 최적화 + 임베딩 조사 (2026-04-01)

> 작성일: 2026-04-01 | 모델: Claude Opus 4.6 (메티)

---

## 이번 세션 전체 성과

### Hub Secrets Store 아키텍처 변경 ✅ (전체 완료!)
- secrets-store.json 생성 (14개 섹션)
- Hub routes.js → loadSecretsStore() 전환
- llm-client.js Hub 경유 변경
- reservation/worker Hub 통합 + secrets.json 삭제
- config.yaml API 키 제거 → git 추적 시작 (런타임 설정만)
- Step 6 최종 정리: 폴백 코드 제거, .gitignore 정리
- pre-commit hook: config.yaml 허용, secrets-store.json 차단
- PG_DIRECT 옵션 추가 (DEV INSERT 가능)
- groq accounts 구조 수정 (문자열→객체 배열)
- llm-keys.js initHubConfig() → llm-fallback.js에 연동 완료

### 공용 스킬 Phase 1~4 전체 완료 ✅
- Phase 1~3: 15파일 (14개 스킬 모듈)
- Phase 4: loader.js + 6개 봇 config skills 등록 + 체크섬 자동화

### LLM 최적화 — 로컬 MLX 전환 ✅
- llm-model-selector: local 프로바이더 + local_fast/local_deep/groq_with_local
- llm-fallback: provider=local → local-llm-client 연동
- config.yaml agentRoutes 7개 에이전트 로컬 전환
- 전체 LLM 호출 테스트 통과:
  qwen2.5-7b: 326ms, deepseek-r1-32b: 62초
  Groq: 270ms, Anthropic: 939ms, Gemini: 4916ms
  OpenAI: 429 쿼타 초과 (예상대로)

### 로컬 임베딩 전환 조사 (진행 중)
- 현재: OpenAI text-embedding-3-small (1536차원, 429 장애)
- 최적 후보: Qwen3-Embedding-0.6B-4bit-DWQ (79K downloads)
- mlx-openai-server: model_type: "embeddings" 지원 확인
- ⚠️ transformers 5.4.0 호환 문제 (batch_encode_plus 제거됨)
- CODEX_LOCAL_EMBEDDING.md 초안 시작

---

## 다음 세션 (즉시 이어서)

```
1순위 🚨: 로컬 임베딩 전환 (CODEX_LOCAL_EMBEDDING.md 완성 → 구현)
  선행: transformers 호환성 수정
    → transformers 다운그레이드 (4.x) 또는 mlx-embeddings 패치
  Step 1: mlx-server-config.yaml에 임베딩 모델 추가
    → model_type: embeddings, Qwen3-Embedding-0.6B-4bit-DWQ
  Step 2: MLX 서버 재시작 + /v1/embeddings 동작 확인
  Step 3: rag.js 수정 (OpenAI curl → localhost:11434/v1/embeddings)
  Step 4: pgvector 차원 변경 (1536 → 모델 출력 차원)
  Step 5: 기존 데이터 재임베딩

2순위: OpenClaw 기술 연구 (C안, 연구팀)
3순위: D 분해 (인프라+루나)
4순위: 블로팀 P1~P5
```

## 핵심 결정

```
[DECISION] Hub = secrets-store.json Single Source of Truth (14섹션)
[DECISION] config.yaml = 런타임 설정 전용 (git 추적)
[DECISION] secrets.json 전부 삭제 (reservation + worker)
[DECISION] 폴백 코드 전부 제거 → Hub 전용
[DECISION] PG_DIRECT=true → DEV INSERT 가능
[DECISION] LLM 7개 에이전트 로컬 MLX 전환 완료
[DECISION] llm-fallback에 initHubConfig() 추가 (Hub 경유 키 로딩)
[DECISION] 임베딩: OpenAI → Qwen3-Embedding-0.6B (로컬) 전환 예정
[DECISION] transformers 5.4.0 호환 문제 → 다음 세션에서 해결
```
