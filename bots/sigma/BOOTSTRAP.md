# BOOTSTRAP.md — 시그마팀 신규 개발자 온보딩

처음 시그마팀 작업에 참여하는 사람(메티/코덱스/마스터)을 위한 10분 시작 가이드.

## 1. 환경 준비

```bash
cd /Users/alexlee/projects/ai-agent-system

# Elixir 1.17+ 확인
elixir --version

# Node.js 22+ 확인
node --version

# PostgreSQL 17 + pgvector 확장 확인
psql -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

## 2. 시그마 디렉토리 구조 이해

먼저 `bots/sigma/README.md` 정독. 그 후 이 순서로:

1. **SOUL.md** — 7가지 원칙
2. **IDENTITY.md** — 팀 정체성
3. **AGENTS.md** — Commander/Pod/Skill/분석가
4. **TOOLS.md** — Jido/req_llm/pgvector/OTel 생태계
5. **USER.md** — 마스터(제이) 의사결정 원칙

## 3. 첫 실행

```bash
cd bots/sigma/elixir
mix compile
mix test

# TS v1 baseline 녹음 (Phase 5 이전 호환)
cd ..
tsx ts/src/sigma-daily.ts --test > /tmp/sigma-baseline-check.json
cat /tmp/sigma-baseline-check.json | head -20
```

## 4. Kill Switch 확인

시그마는 기본 OFF 상태. 활성화는 `.env.sigma` 파일 복사:

```bash
cp .env.sigma.example .env.sigma
# 편집: SIGMA_V2_ENABLED=false → true (프로덕션만)
```

**주의**: Phase 0~2 단계에서는 OFF 유지. Phase 3부터 점진적 true.

## 5. 주요 문서 맵

| 목적 | 파일 |
|------|------|
| 전체 설계 이해 | `docs/PLAN.md` (1,405줄) |
| 논문/개념 보강 | `docs/RESEARCH_V1.md` |
| 버전/API 보강 | `docs/RESEARCH_V2.md` |
| 예제/SDK/관측성 보강 | `docs/RESEARCH_V3.md` |
| 7원칙 운영 정의 | `config/sigma_principles.yaml` |
| 코덱스 Phase 프롬프트 | `docs/codex/PHASE_{0~5}.md` (로컬) |

## 6. 역할별 시작 지점

### 메티 (설계/점검)
- 모든 PLAN/RESEARCH 문서 읽기
- SESSION_HANDOFF_*.md 에서 최근 세션 컨텍스트 습득
- 코덱스 프롬프트 작성 시 Phase별 참조

### 코덱스 (구현)
- `docs/codex/PHASE_*.md` 실행 지시만 따름
- 기존 TS/Elixir v1 수정 금지
- `git mv` 엄수 (히스토리 보존)

### 마스터 (제이, 승인)
- 각 Phase 승인 전 `pre: ...롤백 포인트` 커밋
- launchd 배포/해제 수동 관리

## 7. 긴급 롤백

```bash
# 30초 롤백 절차
launchctl unload ~/Library/LaunchAgents/ai.sigma.daily.plist
git reset --hard <롤백_커밋_SHA>
git push --force-with-lease origin main
# OPS에서 deploy.sh 수동 실행 또는 5분 cron 대기
```

## 8. 문의

문제 발생 시 **마스터에게 직접 보고**. 메티는 설계 문제, 코덱스는 구현 문제 담당.

---

**다음 단계**: [SOUL.md](./SOUL.md) 정독
