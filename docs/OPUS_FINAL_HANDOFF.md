# Opus 세션 인수인계 — Hub Secrets + LLM 최적화 + 임베딩 전환 (2026-04-01)

> 작성일: 2026-04-01 | 모델: Claude Opus 4.6 (메티)

---

## 이번 세션 성과

### Hub Secrets Store 아키텍처 변경 ✅ (전체 완료)
- secrets-store.json = Single Source of Truth (14섹션)
- Hub routes → loadSecretsStore() 전환 + 폴백 코드 전부 제거
- llm-client.js + llm-keys.js Hub 경유 (initHubConfig)
- reservation/worker Hub 통합 + secrets.json 삭제
- config.yaml API 키 제거 → git 추적 시작 (런타임 설정만)
- pre-commit: config.yaml 허용, secrets-store.json 차단
- PG_DIRECT 옵션 (DEV INSERT 가능)
- groq accounts 구조 수정 (문자열→객체 배열)

### LLM 최적화 — 로컬 MLX 전환 ✅
- llm-model-selector: local 프로바이더 + local_fast/local_deep/groq_with_local
- llm-fallback: provider=local + initHubConfig() 호출
- 7개 에이전트 openai→local 전환 (qwen2.5-7b 326ms)
- OpenAI 429 긴급 대응 완료

### 로컬 MLX 임베딩 전환 ✅
- OpenAI text-embedding-3-small(1536) → MLX Qwen3-Embedding-0.6B(1024)
- mlx-server-config: model_type embeddings + qwen3-embed-0.6b
- rag.js: OpenAI curl → 로컬 localhost:11434/v1/embeddings
- pgvector 차원 변경 (1536→1024) + HNSW 인덱스 재생성
- 재임베딩 완료 (1,691건: ops 1037 + trades 591 + tech 53 + video 10)
- RAG 유사도 검색 정상 (283ms, 유사도 0.58~0.61)
- 비용 $0, OpenAI 의존 완전 제거

### 공용 스킬 Phase 1~4 전체 완료 ✅
- 14개 스킬 + 클로드팀 봇 3 + 라이트 4 + loader
- 6팀 config skills 등록 + 체크섬 자동화
- 합계: 24파일+ 2,500줄+

---

## 다음 세션

```
1순위: OpenClaw 기술 연구 (C안, 연구팀 첫 과제)
2순위: D 분해 (인프라+루나)
3순위: 블로팀 P1~P5
4순위: 닥터 L3 강화
5순위: Claude Cowork 연동 검토
```

## 핵심 결정

```
[DECISION] Hub secrets-store.json = Single Source of Truth (14섹션)
[DECISION] config.yaml = 런타임 설정 전용 (git 추적, API 키 0건)
[DECISION] secrets.json 전부 삭제 + 폴백 코드 전부 제거
[DECISION] PG_DIRECT=true → DEV INSERT 가능
[DECISION] LLM 7/10 에이전트 로컬화 (local_fast/groq_with_local)
[DECISION] 임베딩: OpenAI → MLX Qwen3-Embedding-0.6B (1024차원)
[DECISION] pgvector 1536→1024 마이그레이션 + 1,691건 재임베딩 완료
```
