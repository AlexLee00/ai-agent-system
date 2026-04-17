# Sigma Team — Team Jay의 메타 오케스트레이터

시그마팀(대도서관의 심장)은 Team Jay의 9개 팀 + 122 에이전트를 **관찰·분석·편성·피드백**하는 메타 오케스트레이터입니다.

## 빠른 시작

```bash
# Elixir v2 (Jido 기반, 프로덕션 코드 위치는 team_jay Mix 프로젝트)
cd elixir/team_jay
mix deps.get
mix compile --warnings-as-errors
mix test ../../bots/sigma/elixir/test

# TS v1 (레거시, Phase 5에서 thin adapter)
cd ../../bots/sigma
tsx ts/src/sigma-daily.ts --test

# baseline 녹음
tsx ts/src/sigma-daily.ts --test > /tmp/sigma-baseline-$(date +%Y-%m-%d).json
```

## 디렉토리 구조

```
bots/sigma/
├ README.md                    ← 이 파일
├ AGENTS.md                    ← Commander + 3 Pods + 5 Skills + 6 분석가 정의
├ BOOTSTRAP.md                 ← 신규 개발자 온보딩
├ CLAUDE.md                    ← Claude Code 행동 지침
├ HEARTBEAT.md                 ← 헬스체크 + Kill Switch
├ IDENTITY.md                  ← 팀 정체성 + 역사
├ SOUL.md                      ← 7가지 원칙 (sigma_principles.yaml 연결)
├ TOOLS.md                     ← Jido + req_llm + pgvector + OTel 등
├ USER.md                      ← 마스터(제이) 의사결정 원칙
├ .env.sigma.example           ← Kill Switch 환경변수 템플릿
├ config.yaml.example          ← 런타임 설정 템플릿
├ secrets.example.json         ← 시크릿 템플릿
├ package.json                 ← TS 의존성
├ tsconfig.json                ← 시그마 전용 TS 설정
├ elixir/                      ← Jido v2 코어 (프로덕션)
│  ├ lib/sigma/v2/
│  └ test/sigma/v2/
├ ts/                          ← TS v1 (레거시, Phase 5에서 thin)
│  ├ src/sigma-daily.ts
│  └ lib/sigma-{analyzer,feedback,scheduler}.ts
├ shared/                      ← 공유 모듈 (LLM Selector 포함)
│  ├ llm-client.ts             ← 시그마 LLM 게이트웨이
│  ├ llm.ts                    ← 하위호환 래퍼
│  ├ cost-tracker.ts           ← 비용 추적
│  └ secrets.ts                ← 시크릿 로더
├ skills/                      ← agentskills.io 포맷 5개
├ legacy-skills/               ← TS v1 skills (Phase 5에서 archive)
├ config/sigma_principles.yaml ← 7가지 원칙 운영 정의
├ migrations/                  ← PostgreSQL 마이그레이션 (audit + shadow_runs)
├ launchd/                     ← OPS cron (ai.sigma.daily.plist)
└ docs/                        ← 설계서 + 연구 보강 + 코덱스 프롬프트
```

## 역할

시그마는 **4티어 의사결정 게이트**를 통해 팀 제이 전체를 조율합니다:

- **Tier 0 — 관찰만** (알림 없음, audit 로그만)
- **Tier 1 — 권고 메시지** (해당 팀에 advisory)
- **Tier 2 — 자동 적용** (config patch + 24h 롤백 스케줄)
- **Tier 3 — 강제 오버라이드** (절대 금지 사항 위반 차단)

## 상태

- ✅ Phase 0~5 코덱스 구현 완료
- ✅ `bots/sigma/` 물리적 분리 완료 (2026-04-17)
- 🔶 LLM Selector 모듈 구현 대기 (Phase 1.5 후속)
- 🔶 루나팀 표준 정비 중 (LUNA_ALIGN 진행)

## 관련 문서

- 설계서: `docs/PLAN.md`
- 연구 보강: `docs/RESEARCH_V{1,2,3}.md`
- 원칙: `docs/DESIGN_PRINCIPLES.yaml.example` → `config/sigma_principles.yaml`
- Phase 프롬프트: `docs/codex/PHASE_{0~5}.md` (로컬)

---

**Maintained by**: 메티 (설계) + 코덱스 (구현) + 마스터 (제이, 최종 승인)
