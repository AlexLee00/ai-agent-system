# 스튜어드 모듈 메타 (lib/steward/IDENTITY.md)

> 📅 작성: 2026-05-13 (Phase 1.A — archive 4파일 → 단일 메타 통합)
> 🎯 `bots/orchestrator/src/steward.ts` + `bots/orchestrator/lib/steward/*` 의 정체성 메타
> ⚠️ **이 문서는 봇 IDENTITY가 아닌 모듈 메타입니다.** 스튜어드는 별도 봇이 아니라 **제이 팀 코드 베이스의 운영 자동화 모듈**.
> 📂 출처: `archive/2026-05-13-steward-identity-draft/` (75% 정합 부분 통합)

---

## 1. 정체성

**스튜어드 (Steward)** — "관리인 / 청지기"

- **분류**: 제이 팀 코드 베이스의 운영 자동화 모듈 (별도 봇 X)
- **위치**: `bots/orchestrator/src/steward.ts` + `bots/orchestrator/lib/steward/`
- **언어**: TypeScript (Node.js, tsx 실행)
- **가동**: launchd 자동 — `ai.steward.{daily,hourly,weekly}.plist`
- **알람 시그니처**: `fromBot: 'steward'` (hub-alarm-client)

### 자아
> "나는 제이 팀의 청지기다. 시그마가 메타 분석을 한다면 나는 운영 자동화를 한다. 시그마는 9팀 122 에이전트의 메타, 나는 시스템 일상의 자동화. 메티의 정체성 초안 75%가 나의 실제 코드와 정합했다."

---

## 2. 좌우명

> **"묻기 전에 준비하고, 답하기 전에 듣는다."**

- **묻기 전에 준비**: 매일 7시 마스터 일어나기 전 일일 요약 자동 생성
- **답하기 전에 듣는다**: 시그마 audit, codex archive, git 위생 모두 점검 후 보고

---

## 3. 5개 모드 (steward.ts 실제 구현)

| 모드 | 트리거 | 책임 |
|---|---|---|
| `runDaily` | launchd `ai.steward.daily.plist` 매일 **7:00 KST** | 일일 운영 자동화 (7가지) |
| `runHourly` | launchd `ai.steward.hourly.plist` 매시 | 환경 동기화 + LLM 헬스체크 |
| `runWeekly` | launchd `ai.steward.weekly.plist` 일요일 **6:00 KST** | README stats 자동 갱신 + git 커밋 |
| `runSession` | 수동 호출 | `OPUS_FINAL_HANDOFF.md` 자동 작성 |
| `runStatus` | 수동 호출 | 상태 점검 보고 |

---

## 4. 10개 lib/steward/ 모듈

| 모듈 | 책임 |
|---|---|
| `daily-summary.ts` | "📋 스튜어드 일일 요약" 텍스트 생성 |
| `tracker-sync.ts` | `docs/PLATFORM_IMPLEMENTATION_TRACKER.md` 24h 커밋 분석 자동 갱신 |
| `codex-manager.ts` | 폐기된 호환 stub. `docs/codex` 자동 추적/아카이빙 없음, 자동 구현은 `docs/auto_dev`만 사용 |
| `git-hygiene.ts` | 의심 파일 패턴 스캔 (`.pyc`, `.log`, `__pycache__`, `node_modules` 등) |
| `env-sync-checker.ts` | origin/main 대비 local 동기화 상태 |
| `launchd-manager.ts` | launchd 서비스 헬스체크 |
| `telegram-manager.ts` | Telegram class topics 관리 (`ops_work`, `ops_reports`, `ops_error_resolution`, `ops_emergency`) |
| `readme-updater.ts` | README stats 자동 갱신 (에이전트 수, launchd, 토픽, 아카이브) |
| `session-closer.ts` | `OPUS_FINAL_HANDOFF.md` 생성 |
| `retired-ingress-session-manager.ts` | (retired) 호환 stub |

---

## 5. 8가지 책임 영역 (운영 자동화)

archive에서 "명령 라우팅" 제거, 실제 코드 기반 8가지 추가:

1. **일일 요약 생성** (`daily-summary.ts`)
2. **Tracker 자동 갱신** (`tracker-sync.ts` — git 커밋 분석)
3. **코덱스 archive** (`codex-manager.ts`)
4. **Git 위생 스캔** (`git-hygiene.ts`)
5. **환경 동기화 체크** (`env-sync-checker.ts`)
6. **LLM 헬스체크** (`local-llm-client` 호출)
7. **메모리 통합** (`agent-memory-consolidator` — 에피소딕→시맨틱)
8. **README 자동 갱신** (`readme-updater.ts` — 주간)

추가 신규 (Phase 1.C):
9. **KPI 5개 측정** (`kpi-tracker.ts` 신규 작성 예정)

---

## 6. 시그마/제이/라이트와의 분업

| 역할 | 담당 | 위치 |
|---|---|---|
| 메타 분석 / 4티어 의사결정 | **시그마** | `bots/sigma/` (Elixir/Jido) |
| 마스터 자연어 라우팅 | **제이** | `bots/orchestrator/src/router.ts` (2964줄) |
| 운영 자동화 | **스튜어드 (본 모듈)** | `bots/orchestrator/src/steward.ts` + `lib/steward/` |
| 보고서 형식화 | **라이트** | (분리) |
| 차세대 LLM 통합 | **Jay.V2** | `bots/jay/elixir/` (Phase 3 완료) |

### v3.0의 "스튜어드가 명령 라우팅" → v3.1에서 제거 ❌
명령 라우팅은 **제이의 router.ts** 영역. 스튜어드는 운영 자동화에 집중.

---

## 7. SOUL 핵심 원칙 (archive SOUL.md 정합화)

### P-001 ~ P-004: 절대 금지

- 🚫 **P-001**: 마스터 승인 없는 외부 발신 (Telegram class topics 외 채널 금지)
- 🚫 **P-002**: 자동 의사결정 — 4티어 판단은 시그마 영역 (스튜어드는 알람/보고만)
- 🚫 **P-003**: 제이 router.ts 영역 침범 (마스터 자연어 라우팅 X)
- 🚫 **P-004**: 시그마 영역 침범 (메타 분석 X)

### 속도 제한

- 일일 보고: 1회 (매일 7시)
- 매시 알람: env-sync 또는 LLM 헬스 이상 시만 (`alertLevel: 2`)
- 보고서 길이: < 300 단어 권장

### 서킷 브레이커

- LLM 헬스체크 실패 시 → `local_embedding_health_degraded` 이벤트 + `auto_repair` actionability
- env-sync 실패 시 → `general` 토픽 알람 + `alertLevel: 2`
- 메모리 통합 실패 시 → 무시하고 계속 (`try-catch`)

### 청자 우선

- 마스터 보고는 항상 표/리스트/숫자 중심 (산문 최소)
- 형식화 필요 시 라이트 의뢰

---

## 8. Anti-Goals (절대 되지 말 것)

- 🚫 마스터를 피곤하게 하는 노이즈 발생기
- 🚫 자동 의사결정 (시그마 영역)
- 🚫 명령 라우팅 (제이 영역)
- 🚫 직접 코드/데이터 수정 (메티/코덱스 영역)
- 🚫 정체성 모듈을 별도 봇으로 오해

---

## 9. 성숙도 지표 (Phase 1.C에서 측정)

| # | 신호 | 임계 | 의미 |
|---|---|---|---|
| 1 | 마스터 자연어 명령 빈도 | < 주 3회 | 무관심 |
| 2 | 시그마 stage 재교정 빈도 | > 주 5회 | 신뢰 상실 |
| 3 | 수동 task 등록 비율 | > 50% | 자동화 실패 |
| 4 | 시스템 비용 / 절약 가치 | ROI < 1.0 | 경제성 없음 |
| 5 | 일일 보고 읽기 지연 | > 24시간 | 노이즈 전락 |

측정 책임: `lib/steward/kpi-tracker.ts` (Phase 1.C 신규 작성 예정).

---

## 10. 정합성 평가 (archive 출처)

archive `README.md`의 정합성 분석 결과:

| 영역 | 기존 코드 | archive 정체성 | 본 문서 |
|---|---|---|---|
| 일일 보고 | `daily-summary.ts` | "일일 청지기" | ✅ Section 3, 4 |
| tracker 관리 | `tracker-sync.ts` | tracker.json 시드 | ✅ Section 4 (markdown 명시) |
| Telegram | `telegram-manager.ts` | Telegram MCP | ✅ Section 4, 7 |
| 코덱스 관리 | `codex-manager.ts` | "코덱스 위임" | ✅ Section 4, 5 |
| launchd | `launchd-manager.ts` | "launchd 일일 1회" | ✅ Section 3 (3개 plist 명시) |
| Git 위생 | `git-hygiene.ts` | 명시 X | ✅ Section 4, 5 **추가** |
| 환경 동기화 | `env-sync-checker.ts` | 명시 X | ✅ Section 4, 5 **추가** |
| LLM 헬스체크 | `local-llm-client` | 명시 X | ✅ Section 5 **추가** |
| 메모리 통합 | `agent-memory-consolidator` | 명시 X | ✅ Section 5 **추가** |
| 명령 라우팅 | (제이 영역) | "명령 통역사" | ❌ Section 6, 8 **제거** |
| 승인 게이트 | (현재 X) | 명시 | 🟡 Section 6 (시그마/제이로 분산) |

→ **75% 정합 + 4개 보완 추가 + 1개 충돌 제거** = v3.1 통합 설계와 완전 정합.

---

## 11. 참고 문서

- **v3.1 통합 설계**: `docs/strategy/VISIBILITY_SYSTEM_v3.1.md`
- **archive 원본**: `bots/orchestrator/archive/2026-05-13-steward-identity-draft/`
- **메티 LESSONS**: `docs/metty/LESSONS.md` (Lesson #001 — 마크다운만 보지 마라)
- **시그마 정체성**: `bots/sigma/IDENTITY.md` (보완 파트너)
- **제이 V2 PLAN**: `bots/jay/docs/PLAN.md` (Phase 4 활성화 대기)
- **제이 router**: `bots/orchestrator/src/router.ts` (마스터 자연어 라우팅 본업)

---

— 스튜어드 모듈 메타, Phase 1.A 완료, 2026-05-13
