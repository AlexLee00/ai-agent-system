# Opus 세션 인수인계 (2026-04-01)

> 작성일: 2026-04-01 | 모델: Claude Opus 4.6 (메티)

---

## 이번 세션 전체 성과

### Hub Secrets Store 아키텍처 변경 ✅ (전체 완료)
- secrets-store.json = Single Source of Truth (14섹션)
- config.yaml API 키 제거 → git 추적 시작 (런타임 설정만)
- reservation/worker secrets.json 삭제 → Hub 경유
- llm-client.js + llm-keys.js Hub 경유 변경
- 폴백 코드 전부 제거 (Step 6)
- pre-commit: config.yaml 허용, secrets-store.json 차단
- PG_DIRECT=true (DEV INSERT 가능)
- groq accounts 구조 수정 (문자열→객체 배열)

### LLM 최적화 — 로컬 MLX 전환 ✅
- 7/10 에이전트 로컬화 (OpenAI 429 긴급 대응)
- llm-model-selector: local 프로바이더 + local_fast/local_deep/groq_with_local
- llm-fallback: provider=local → local-llm-client 연동
- llm-keys.js: initHubConfig → llm-fallback에서 자동 호출
- qwen2.5-7b: 326ms (2차 호출), Groq Kimi K2: 176ms

### 임베딩 로컬 전환 ✅
- OpenAI text-embedding-3-small(1536) → MLX Qwen3-Embedding-0.6B(1024)
- rag.js: OpenAI curl → 로컬 localhost:11434/v1/embeddings
- pgvector 차원 변경 (1536→1024) + HNSW 인덱스 재생성
- 기존 1,691건 재임베딩 완료
- RAG 검색 테스트: 유사도 0.58~0.61, 283ms
- 비용 $0, OpenAI 의존 완전 제거

### 공용 스킬 Phase 1~4 ✅ (24파일+ 2,500줄+)
- Phase 1: code-review, verify-loop, plan (4파일 328줄)
- Phase 2: 클로드팀 봇(reviewer/guardian/builder) + 라이트 (7파일 742줄)
- Phase 3: 나머지 11개 스킬 (12파일 1,150줄)
- Phase 4: loader.js + 6팀 config 등록 + 체크섬 자동화

### CI/CD + 보안 ✅
- GitHub Actions self-hosted runner (OPS ARM64)
- quality-check.yml (리뷰어+가디언+빌더+라이트+체크섬)
- ai.write.daily launchd (매일 07:00 KST)
- 공개 레포 보안 확인 (시크릿 노출 0건)

---

## 다음 세션

```
1순위: OpenClaw 기술 연구 (C안, 연구팀)
  → mainbot.js 흡수 설계
  → GPT-5.4 OAuth 연동 테스트
  → Cowork 연동 검토

2순위: D 분해 (인프라+루나)

3순위: 블로팀 P1~P5

4순위: 닥터 L3 강화 (verify-loop 연동)

5순위: Chronos Tier 2 본격 구현
```

## 핵심 결정

```
[DECISION] Hub = secrets-store.json Single Source of Truth (14섹션)
[DECISION] config.yaml = 런타임 설정 전용 (git 추적, API 키 없음)
[DECISION] secrets.json 전부 삭제 (reservation + worker)
[DECISION] 폴백 코드 전부 제거 → Hub 전용
[DECISION] PG_DIRECT=true → DEV INSERT 가능 (sql-guard 우회)
[DECISION] pre-commit: config.yaml 허용, secrets-store.json 차단
[DECISION] LLM 7/10 에이전트 로컬화 (local_fast/groq_with_local)
[DECISION] 임베딩: Qwen3-Embedding-0.6B (1024차원, 로컬, $0)
[DECISION] pgvector: 1536→1024 차원 변경 + 1,691건 재임베딩
[DECISION] 스킬 Phase 1~4 전체 완료 (24파일+ 2,500줄+)
[DECISION] CI/CD: self-hosted runner + quality-check.yml + launchd daily
[DECISION] groq accounts: 객체 배열 { api_key: "..." } 구조
[DECISION] llm-keys initHubConfig: llm-fallback에서 자동 호출
```
