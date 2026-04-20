# 팀 제이 (Team Jay) — Claude Code 세션 가이드

> 레포: AlexLee00/ai-agent-system
> 최종 업데이트: 2026-04-01

---

## 팀 구조

| 구분 | 이름 | 역할 |
|------|------|------|
| 마스터 | Alex (제이) | 전략, 예외 승인 |
| 메인봇 | 제이 (Jay) | 총괄 허브, 오케스트레이션 |
| 제이 직속 | 라이트 (Write) | 문서 관리, 팀장회의록, 일일 리포트 |
| 투자팀장 | 루나 | 자동매매 (crypto live, 국내외 mock) |
| 시스템팀장 | 클로드 | 모니터링, 유지보수 (덱스터/아처/닥터) |
| SKA팀장 | 스카 | 스터디카페 예약/매출 관리 |
| 블로팀장 | 블로 | 네이버 블로그 자동화 |
| 워커팀장 | 워커 | 비즈니스 관리 SaaS |
| 비디오팀장 | 에디 | 영상 자동편집/자동생성 시스템 |
| 연구팀장 | (예정) | 새 기술 R&D, 시스템 매시간 업그레이드 |
| 감정팀장 | (예정) | 법원 소프트웨어 감정 자동화 |

### 3계층 에이전트 모델
```
Layer 3: 마스터 (Alex) — 전략, 예외 승인
Layer 2: 팀장 봇 (LLM) — 자율 판단·조율
Layer 1: 팀원 봇 (규칙) — 실행·보고
```

## 6대 원칙

1. **자율과 통제의 균형** — 봇은 진화하되, 비용과 권한은 통제
2. **감지와 판단의 분리** — 감지(덱스터)와 판단(팀장)을 분리
3. **정합성 우선** — 실행은 빠르게, 데이터 정합성은 절대 보존
4. **기록이 곧 진화** — 모든 판단을 추적. 기록 없이 개선 없음
5. **비용 의식** — 무료 모델 최대 활용, 유료는 가치 있는 곳에만
6. **노드 단위 업무 분리** — 모든 파이프라인을 노드로 분해

## 인프라

```
OPS: Mac Studio M4 Max 36GB (24/7 운영)
  Hub(:7788), PostgreSQL(:5432), n8n(:5678), MLX(:11434), OpenClaw(:18789)
DEV: MacBook Air M3 (개발 전용, Tailscale 연결)
배포: git push → 5분 cron 자동 pull + GitHub Actions CI (self-hosted runner OPS)
DB: PostgreSQL 단일 (jay DB) + pgvector — 별도 DB 추가 금지

시크릿 아키텍처:
  bots/hub/secrets-store.json = Single Source of Truth (모든 API 키, gitignore)
  bots/investment/config.yaml = 런타임 설정만 (git 추적, API 키 없음!)
  reservation/worker secrets.json = 삭제됨 (Hub 경유)

LLM 아키텍처:
  로컬 MLX (:11434) — qwen2.5-7b(현재 배포 fast) + deepseek-r1-32b(현재 배포 deep) + qwen3-embed-0.6b(임베딩) + gemma4:latest(gemma-4-e2b-it-4bit 로컬 alias, Gemma 파일럿)
  최신 공식 계열 참고: Qwen3 / Qwen3-Embedding / Gemma 3·3n / DeepSeek V3.x
  7/10 에이전트 로컬화: hermes/sophia/zeus/athena/nemesis/oracle → local_fast
  루나 → groq_with_local (Groq Qwen3-32B → local deepseek-r1-32b 폴백)
  임베딩: Qwen3-Embedding-0.6B (1024차원, 로컬, 비용$0)
  DEV DB 접근: PG_DIRECT=true → SSH 터널 직접 연결 (INSERT 가능)
```

## 문서 체계 (7대 카테고리)

```
세션:     CLAUDE.md (이 파일) + bots/*/CLAUDE.md (팀별 자동 로드)
전략:     docs/STRATEGY.md + docs/strategy/{팀}.md
개발:     docs/DEVELOPMENT.md + docs/dev/{팀}.md
히스토리: docs/history/ (WORK_HISTORY, CHANGELOG, TEST_RESULTS)
연구:     docs/research/ (RESEARCH_JOURNAL, RESEARCH_2026)
코덱스:   docs/codex/ (활성 프롬프트만)
가이드:   docs/guides/ (coding, security, ops, db, llm)
아카이브: docs/archive/ (완료된 문서)
```

### 문서 관리 원칙
1. 새 코덱스 프롬프트 → `docs/codex/`에 생성
2. 코덱스 완료 시 → `docs/archive/codex-completed/`로 이동
3. 세션 종료 시 → `docs/OPUS_FINAL_HANDOFF.md` 업데이트 필수
4. 전략 변경 시 → `docs/STRATEGY.md` 또는 `docs/strategy/{팀}.md` 반영
5. 작업 기록 → `docs/history/WORK_HISTORY.md`에 날짜별 추가
6. 연구/리서치 → `docs/research/`에 축적

## 역할 원칙 (불변)

- **메티(Meti)** = 기획+설계+코드점검 에이전트 (Claude Opus). 코드 직접 수정 절대 금지.
- **코덱스(Codex)** = 코드 구현 에이전트 (Claude Code Sonnet). 모든 실제 구현 담당.
- 코덱스 구현 → 메티 점검(문법/소프트/하드 테스트) → 마스터 승인 순서 준수.
- 모든 코드 구현은 **맥북 에어(DEV)**에서 진행. 맥 스튜디오(OPS) 직접 수정 금지가 기본.

## 절대 규칙 (변경 불가)

- 시스템 기본 언어: **한국어**
- secrets-store.json, API 키 파일은 절대 Git 커밋 금지 (pre-commit hook 차단)
- config.yaml은 git 추적 가능 (API 키 없음, 런타임 설정만)
- 소스코드 수정 권한: **마스터(Alex)와 Claude Code만** — 모든 봇 절대 금지
- 실투자 보호: TP/SL 거래소 설정 필수. tp_sl_set 확인 전 포지션 활성화 금지
- DB/코드 파일 자동 삭제 금지
- 팀 경계 침범 금지: 타 팀 DB 직접 접근 금지 (State Bus 경유)
- LLM 판단으로 OPS 데이터 직접 수정 금지 (규칙 기반 실행봇 경유)
- DEV/OPS 데이터 격리: MODE=dev에서 OPS 데이터 접근 금지

## 공통 유틸리티 (신규 코드 필수 사용)

- **시간**: `packages/core/lib/kst.js` — `new Date()` 직접 사용 금지, `kst.today()` 등 사용
- **DB**: `packages/core/lib/pg-pool.js` — 공용 PostgreSQL 연결 (DEV: PG_DIRECT=true면 직접, 아니면 Hub 경유)
- **Hub**: `packages/core/lib/hub-client.js` — 시크릿/에러/DB 쿼리
- **LLM 호출**: `packages/core/lib/llm-fallback.js` — 프로바이더별 폴백 체인 (local/groq/anthropic/openai/gemini)
- **LLM 키**: `packages/core/lib/llm-keys.js` — Hub secrets-store에서 API 키 로딩 (initHubConfig 필수!)
- **LLM 선택**: `packages/core/lib/llm-model-selector.js` — 에이전트별 라우팅 (local_fast/local_deep/groq_with_local)
- **LLM 로컬**: `packages/core/lib/local-llm-client.js` — 로컬 MLX LLM (현재 배포: qwen2.5-7b/deepseek-r1-32b, 임베딩: qwen3-embed-0.6b)
- **RAG**: `packages/core/lib/rag.js` — 로컬 MLX 임베딩 (Qwen3-Embedding-0.6B, 1024차원, pgvector)
- **스킬**: `packages/core/lib/skills/` — 14개 공용 스킬 + loader.js (봇 config에서 자동 로딩)
- **환경**: `packages/core/lib/env.js` — DEV/OPS 환경 분기
- **launchd**: StartCalendarInterval은 KST 기준 — UTC 변환 금지

## 개발 루틴

### 세션 시작
1. CLAUDE.md 읽기 (자동)
2. docs/OPUS_FINAL_HANDOFF.md 읽기 (이전 세션 컨텍스트)
3. docs/KNOWN_ISSUES.md 확인
4. git status 확인

### 세션 마무리
1. Git 커밋 + push
2. docs/OPUS_FINAL_HANDOFF.md 업데이트
3. docs/history/WORK_HISTORY.md 업데이트 (오늘 한 일)
4. 필요 시: CHANGELOG, KNOWN_ISSUES, RESEARCH_JOURNAL 업데이트

### 포스트 리붓 운영 메모
- 재부팅 직후에는 `scripts/post-reboot.sh`를 먼저 실행하고, follow-up 파일(`/tmp/post-reboot-services.txt`, `/tmp/post-reboot-followup.txt`)을 기준으로 복구 상태를 점검한다.
- 운영 확인 우선순위는 `hub / n8n / mlx / rag` → `luna / blog / ska / worker / claude` 순서로 유지한다.
- 예약팀 `today-audit`는 launchd 스케줄을 놓친 재부팅 케이스가 생길 수 있으므로, 필요 시 wrapper 경로 `bots/reservation/auto/monitors/run-today-audit.sh`로 수동 실행해 `/tmp/today-audit.log` 성공 이력을 복구한다.

### 커밋 규칙
- 의미 있는 단위로 자주 커밋 (몰아서 ❌)
- 접두사: `feat:`, `fix:`, `docs:`, `chore:` + 한국어
- 보안 검사 자동 실행 (pre-commit hook)

---

> 상세 전략: docs/STRATEGY.md | 상세 개발: docs/DEVELOPMENT.md
> 팀별 컨텍스트: bots/*/CLAUDE.md | 참조 문서: team-jay-strategy.md
