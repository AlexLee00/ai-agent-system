# BOOTSTRAP.md — 다윈팀 신규 개발자 온보딩

처음 다윈팀 작업에 참여하는 사람(메티/코덱스/마스터)을 위한 10분 시작 가이드.

## 1. 환경 준비

```bash
cd /Users/alexlee/projects/ai-agent-system

# Elixir 1.17+ 확인
elixir --version

# Node.js 22+ 확인
node --version

# PostgreSQL + pgvector 확인
psql -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

## 2. 다윈팀 디렉토리 구조

```
bots/darwin/
├ AGENTS.md          ← 에이전트 명세
├ BOOTSTRAP.md       ← 이 파일
├ CLAUDE.md          ← Claude Code 행동 지침
├ HEARTBEAT.md       ← 헬스체크 + Kill Switch
├ IDENTITY.md        ← 팀 정체성
├ README.md          ← 빠른 시작
├ SOUL.md            ← 7원칙
├ TOOLS.md           ← LLM/Elixir/TS 생태계
├ USER.md            ← 마스터 컨텍스트
├ config/
│  └ darwin_principles.yaml   ← Constitutional 원칙
├ elixir/
│  ├ mix.exs                  ← team_jay 위임 빌드
│  ├ lib/darwin/v2/           ← V2 Elixir 코어
│  └ test/darwin/v2/          ← 테스트
├ lib/                        ← V1 TypeScript
├ migrations/                 ← DB 마이그레이션 (4개)
└ sandbox/                    ← 실험 결과물 (gitignored)
```

## 3. 첫 실행

```bash
cd bots/darwin/elixir
mix compile
mix test

# V1 TS 스캐너
cd ..
node scripts/research-task-runner.ts --test
```

## 4. Kill Switch 확인

다윈 V2는 기본 OFF. 활성화:
```bash
export DARWIN_V2_ENABLED=true
export DARWIN_CYCLE_ENABLED=true    # 7단계 사이클
# export DARWIN_L5_ENABLED=true     # 완전자율 (Phase 후 활성화)
```

## 5. 자율 레벨 현황

현재 레벨: sandbox/darwin-autonomy-level.json 참조

| 레벨 | 자동 구현 | 자동 main 통합 |
|------|---------|-------------|
| L3 | ❌ | ❌ |
| L4 | ✅ | ❌ (알림만) |
| L5 | ✅ | ✅ |

## 6. 주요 문서 맵

| 목적 | 파일 |
|------|------|
| 에이전트 구조 | AGENTS.md |
| V2 설계 | docs/codex/CODEX_DARWIN_REMODEL.md (로컬) |
| LLM 라우팅 | elixir/lib/darwin/v2/llm/selector.ex |
| Constitutional 원칙 | config/darwin_principles.yaml |

## 7. 긴급 롤백

```bash
# Darwin V2 즉시 비활성
export DARWIN_V2_ENABLED=false
# OPS: deploy.sh 수동 실행 (환경변수 반영)
```
