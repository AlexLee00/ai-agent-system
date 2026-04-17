# SESSION HANDOFF — 2026-04-17 보안 감사 1차

> 작성자: 메티(Metis) @ claude.ai
> 작성일: 2026-04-17 (금)
> 세션 유형: 소스코드 취약점 감사
> 다음 세션 유형: 감사 2차 + 1차 패치 검증

---

## 🎯 이번 세션 결과

마스터 제이의 지시로 **Desktop Commander를 통해 OPS 서버의 실제 소스코드를 직접 분석**하는 방식의 취약점 감사를 시작함. 50만 라인 규모 코드베이스를 **단위별로 끊어서** 진행하기로 합의하고, 1단위(Hub + Git 추적 민감 정보)를 마무리.

### 📊 프로젝트 규모 파악 결과

```
경로: /Users/alexlee/projects/ai-agent-system (OPS)
규모: 약 509,264 라인
파일 수: 2,956개 (node_modules/venv/dist/_build 제외)
  - JavaScript: 1,461
  - TypeScript: 1,125
  - Elixir:     628
  - Python:     36
```

### ✅ 점검 완료 영역 (1단위: Hub)

1. **Hub 서버 전수 점검**
   - `bots/hub/src/hub.ts` (253라인) — 라우트 바인딩, graceful shutdown, rate limit
   - `bots/hub/lib/auth.ts` — Bearer Token + timing-safe 비교 ✅ 안전
   - `bots/hub/lib/sql-guard.ts` — 블랙리스트 방식 SQL 검증
   - `bots/hub/lib/routes/pg.ts` — PostgreSQL 쿼리 라우트
   - `bots/hub/lib/routes/secrets.ts` — 시크릿 카테고리 라우트 (11개 카테고리)

2. **런타임 검증**
   - `lsof -nP -iTCP:7788 -sTCP:LISTEN` → `*:7788` 확인 (전체 노출)
   - `secrets-store.json` 권한 확인 → `600` ✅
   - `.gitignore` 검증 → secrets-store.json 등록 ✅
   - Git 추적 파일 검색 → `bots/investment/config.yaml`이 Public 리포에 커밋됨

### 🚨 발견된 취약점 3건

| # | 심각도 | 위치 | 요약 |
|---|-------|------|------|
| 1 | 🔴 HIGH | `bots/hub/src/hub.ts` | Hub `0.0.0.0:7788` 바인딩 — 전략 문서 §9-2 위반 (loopback만 바인딩 원칙) |
| 2 | 🟡 MEDIUM | `bots/investment/config.yaml` | 실 KIS 계좌번호 + USDT 지갑주소가 Public Git에 커밋 (구체값은 `docs/codex/CODEX_SECURITY_AUDIT_01.md` 참조 — gitignore) |
| 3 | 🟢 LOW-MED | `bots/hub/lib/sql-guard.ts` | 블랙리스트만 사용, `pg_read_file`/`dblink` 등 PostgreSQL 위험 함수 미차단 |

### 📝 코덱스 프롬프트 작성 완료

**산출물**: `docs/codex/CODEX_SECURITY_AUDIT_01.md` (약 330라인)

- 3건의 취약점을 Task 1/2/3으로 묶어 구현 지시서 작성
- 각 태스크별 구현 요구사항 + 수락 기준 명시
- 메티 독립 검증 계획 3단계 (정적/소프트/하드)
- 마스터 승인 포인트 4건 명시 (force push, 지갑 로테이션 등)

### 🟢 긍정적으로 확인된 요소

- `auth.ts`의 `crypto.timingSafeEqual` 사용 (타이밍 공격 방어)
- Rate limiter 차등 적용 (전역 200/min, DB 120/min, secrets 60/min)
- Express body limit `1mb` 설정
- URI 길이/반복 패턴 방어 (`/(.)\1{50,}/`)
- Graceful shutdown + uncaught overflow 방어
- SQL 가드 `;` 다중 statement 차단
- `secrets-store.json` 600 권한
- PostgreSQL 스키마 화이트리스트 8개

---

## 🔧 다음 세션에서 할 일

### 우선순위 1 — 1차 패치 검증

코덱스가 `docs/codex/CODEX_SECURITY_AUDIT_01.md`를 구현했다면, 메티가 **독립 검증** 수행:

```bash
# 정적 검증
lsof -nP -iTCP:7788 -sTCP:LISTEN  # 127.0.0.1만 확인
cd /Users/alexlee/projects/ai-agent-system
git grep "<KIS_ACCOUNT_NUMBER>"     # 0 결과 (실제 값은 CODEX_SECURITY_AUDIT_01.md 참조)
git grep "<USDT_DEPOSIT_ADDRESS>"   # 0 결과 (실제 값은 CODEX_SECURITY_AUDIT_01.md 참조)
npm run typecheck:strict

# 소프트 테스트
curl -s http://127.0.0.1:7788/hub/health | jq
curl -v http://<OPS-LAN-IP>:7788/hub/health  # Connection refused 기대

# 하드 테스트 — SQL 인젝션 시도
curl -X POST http://127.0.0.1:7788/hub/pg/query \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT pg_read_file(\"/etc/passwd\")", "schema": "public"}'
# 400 blocked 기대
```

### 우선순위 2 — 감사 2단위 (투자팀)

실투자가 걸려있어 민감도 최고.

예상 점검 영역:
```
[ ] bots/investment/shared/db.js — DB 접근 (PostgreSQL 파라미터 바인딩)
[ ] bots/investment/shared/secrets.ts — 시크릿 로딩
[ ] bots/investment/nodes/hephaestos.* — 매매 실행 (OCO 주문 로직)
[ ] bots/investment/nodes/nemesis.* — 리스크 검토 (우회 가능한가?)
[ ] bots/investment/luna-commander.cjs — 자율 루프 (무한 루프/리소스 누수)
[ ] bots/investment/team/** — 분석팀 LLM 호출 (프롬프트 인젝션)
[ ] bots/investment/markets/binance/** — API 서명, nonce, 리플레이 방어
[ ] bots/investment/markets/kis/** — 토큰 갱신, 재시도 로직
[ ] bots/investment/migrations/** — 스키마 변경 안전성
```

**2단위 핵심 질문**:
1. 바이낸스 API 서명이 로그에 남는가? URL에 시크릿이 포함되는가?
2. `paper_mode=true`일 때도 실제 주문 API를 호출하는 버그 없는가?
3. 네메시스 리스크 검토 통과 전 매매 실행되는 경로가 있는가?
4. 서버 응답한 주문 수량이 요청과 다를 때 처리 로직 있는가?
5. 헤파이스토스 OCO 주문 실패 시 포지션 보호 동작하는가?

### 우선순위 3 — 감사 3단위 이후 로드맵

```
3단위: bots/worker/ (JWT + 멀티테넌트 격리 + 파일 업로드)
4단위: bots/reservation/ (Playwright + DB 암호화)
5단위: bots/blog/ (Instagram OAuth + 썸네일/숏폼)
6단위: packages/core/lib/ (env, pg-pool, llm-router, state-bus)
7단위: elixir/ (Supervisor 트리, PortAgent 권한)
8단위: 의존성 감사 (npm audit, pip freeze | safety check)
9단위: Git 히스토리 전수 조사 (trufflehog, gitleaks)
```

---

## 📂 핵심 파일 위치

```
# 이번 세션 산출물
docs/codex/CODEX_SECURITY_AUDIT_01.md      # 1차 패치 코덱스 프롬프트 (작성 완료, ~330줄)
docs/SESSION_HANDOFF_2026-04-17.md          # 이 파일

# 점검 완료 (1단위)
bots/hub/src/hub.ts                        # HIGH — 0.0.0.0 바인딩
bots/hub/lib/auth.ts                       # ✅ 안전
bots/hub/lib/sql-guard.ts                  # LOW-MED — 블랙리스트 보강 필요
bots/hub/lib/routes/pg.ts                  # 조건부 안전 (sql-guard 의존)
bots/hub/lib/routes/secrets.ts             # 안전
bots/hub/secrets-store.json                # 권한 600 ✅ (Git 제외)

# 점검 대상 (2단위 — 다음 세션)
bots/investment/config.yaml                # MEDIUM — Git 추적 민감 필드
bots/investment/shared/                    # 다음 세션 점검
bots/investment/nodes/                     # 다음 세션 점검
bots/investment/markets/                   # 다음 세션 점검
bots/investment/luna-commander.cjs         # 자율 루프
```

---

## ⚠️ 다음 세션이 알아야 할 것

### 환경 컨텍스트

- **OPS 서버**: Mac Studio M4 Max (`Alexui-MacStudio.local`), macOS arm64
- **현재 실행 중**: Hub PID 49599 (포트 7788) — 재기동 전에 소비자 봇들 영향 확인 필요
- **메티 접근 방식**: Desktop Commander (claude.ai)
- **코덱스 접근 방식**: Claude Code on DEV (맥북 에어), SSH로 OPS 작업
- **Git 리포**: `AlexLee00/ai-agent-system` (Public) — 민감 정보 커밋 즉시 주의

### 메티 원칙 재확인

- ❌ **코드 직접 수정 금지** — 이번 세션에서 문서(프롬프트)만 작성
- ✅ **정적 점검 + 프롬프트 작성** — 이번 세션 한 일
- ✅ **독립 검증** — 다음 세션에서 코덱스 구현 완료 후 수행
- 📝 OPS 설정 파일(launchd plist 등) 수정은 코덱스 → 메티 검증 → 마스터 승인 절차 엄수

### 세션 한계 관리

- 이번 세션은 도구 호출 한계 근처에서 여러 번 중단 → 프롬프트·핸드오버를 청크 단위로 작성
- 다음 세션에서 긴 소스 전수 조사 시, **파일 단위로 잘라서 점검 + 중간 요약** 권장
- 큰 소스는 200라인 청크 단위 읽기, 관찰한 이슈는 중간중간 목록화

### 보안 감사 vs 다른 트랙

userMemories 기준, 보안 감사와 별개로 진행 중이던 작업들:

```
[ ] tsx Stage 1 실행 (TS 마이그레이션)
[ ] 루나팀 pip 설치 + 실데이터 검증 (Part D/E/H)
[ ] 인스타그램 Meta Developer 등록 (마스터 작업)
[ ] n8n 자격증명 에러 미해결
[ ] Elixir PortAgent 루나팀 운영 전환 마무리
```

**판단 포인트**: Task 1(Hub 바인딩)은 🔴 HIGH 심각도이므로 다른 트랙보다 우선 반영 권장. Task 2/3은 상황에 따라 병행 가능.

---

## 🔄 다음 세션 시작 체크리스트

```
[ ] 이 문서(SESSION_HANDOFF_2026-04-17.md) 읽기
[ ] docs/codex/CODEX_SECURITY_AUDIT_01.md 읽기
[ ] 마스터에게 확인: 코덱스가 1차 패치를 구현했는가?
    [ ] 구현 완료 → 메티 독립 검증 (우선순위 1)
    [ ] 미구현 → 구현 대기 + 감사 2단위 진행 (우선순위 2)
    [ ] 일부 구현 → 완료분만 검증 + 미완료분 코덱스 재확인
[ ] 감사 2단위(투자팀) 시작 시 현재 실운영 상태 확인
    [ ] 바이낸스 실매매 on/off 여부
    [ ] KIS live 모드 상태
    [ ] 루나팀 PortAgent 운영 전환 진행 상황
[ ] 세션 종료 시 SESSION_HANDOFF_2026-04-18.md 작성
```

---

## 📚 참고 문서

- `team-jay-strategy.md` §9 — 보안 정책 (이번 감사의 기준)
- `team-jay-strategy.md` §9-2 — 네트워크 바인딩 원칙
- `docs/ROLE_PRINCIPLES.md` — 메티/코덱스/마스터 역할 원칙
- `docs/KNOWN_ISSUES.md` — 이번 취약점 3건 추가 필요
- `CLAUDE.md` — 절대 규칙

---

## 🏷️ 이번 세션 요약 한 줄

**Hub + config.yaml에서 3건의 취약점 확인, 코덱스 프롬프트(Task 1/2/3) 작성 완료. 다음 세션은 1차 패치 검증 → 투자팀 2단위 감사.**

— 메티 (2026-04-17)

---

## 🔀 [추가] PortAgent 전환 인벤토리 — 다음 세션 우선 작업

> 마스터가 2026-04-17 세션 말미에 분류 전략 확정.
> 다음 메티 세션에서 **실전 인벤토리**를 만들어 코덱스에 전달할 예정.

### 마스터 확정 분류 전략 (2026-04-17)

```
┌─────────────────────────────────────────────────────────────┐
│ A. PortAgent 전환 (즉시 가능 — 작업형 잡)                      │
├─────────────────────────────────────────────────────────────┤
│ • investment 스케줄: prescreen-*, market-alert-*,            │
│   reporter, health-check, unrealized-pnl                    │
│ • blog 배치: commenter, daily, collect-*, marketing-*        │
│ • worker 배치: health-check, claude-monitor,                 │
│   task-runner류 비상 재실행 가능 잡                            │
│                                                              │
│ → 공통 특성: 짧게 돌고 끝나는 작업, Supervisor와 잘 맞음        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ B. launchd 유지 (OS-level daemon)                             │
├─────────────────────────────────────────────────────────────┤
│ • ai.openclaw.gateway                                        │
│ • ai.n8n.server                                              │
│ • ai.mlx.server                                              │
│                                                              │
│ → 공통 특성: OS daemon 성격, launchd 자연스러움                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ C. 조건부 전환 (상시 서버형)                                    │
├─────────────────────────────────────────────────────────────┤
│ • hub_resource_api                                           │
│ • blog_node_server                                           │
│ • worker_web, worker_nextjs                                  │
│ • ai.ska.naver-monitor, ai.ska.kiosk-monitor                 │
│ • ai.investment.commander                                    │
│                                                              │
│ → 전환 전 선결 조건:                                          │
│   1. health probe 안정                                       │
│   2. self-heal noise 억제                                    │
│   3. cutover/rollback 절차 확정                               │
│   4. ownership manifest 반영                                 │
│   5. health-check false alert 제거                           │
└─────────────────────────────────────────────────────────────┘
```

### 전체 실행 전략 (한 줄)

**스케줄 잡 100% PortAgent 정리 → launchd/Elixir 이중 소유 흔적 제거 → daemon 하나씩 승격 → 최종적으로 launchd를 core daemon만 남기기**

### 다음 메티 세션 실행 절차

```
1. launchd plist 전수 스캔
   ls ~/Library/LaunchAgents/ai.*.plist
   ls /Library/LaunchDaemons/ai.*.plist (있으면)
   launchctl list | grep -E "ai\.|system\."

2. Elixir Supervisor 트리 확인
   cat elixir/lib/*/application.ex
   cat elixir/lib/*/supervisor.ex
   (이미 Elixir에 올라간 31개 vs 아직 launchd 50개 구분)

3. 각 서비스별 메타데이터 수집
   - plist 경로
   - 실행 명령 + cwd
   - 스케줄 (StartInterval / StartCalendarInterval)
   - KeepAlive / RunAtLoad
   - 실행 시간 추정 (log 기반 평균)
   - 재시도 정책
   - 로그 경로
   - 실패 시 영향도 (실매매? UI? 내부?)

4. 3칸 인벤토리 테이블 작성
   | Service | 분류(A/B/C) | 근거 | 전환 우선순위 | 비고 |

5. PortAgent 전환 실행 플랜 작성
   - Phase 1: A그룹 중 가장 단순한 것부터
   - Phase 2: A그룹 나머지
   - Phase 3: C그룹 선결조건 충족되는 순서
   - B그룹: 전환 없음, 문서화만

6. 코덱스 프롬프트화
   docs/codex/CODEX_PORTAGENT_MIGRATION_PLAN.md
```

### 주의사항

- **이중 소유 리스크**: 현재 31개 launchd → Elixir 전환 이력 있음. 이미 Elixir에 올라간 서비스가 launchd에도 plist 잔여하는지 전수 확인 필요 (userMemories: "50개 launchd 잔존")
- **스케줄 잡 vs 상시 잡 구분 기준**: plist의 `StartInterval` / `StartCalendarInterval` 있으면 스케줄, `KeepAlive=true` + `RunAtLoad=true`면 상시
- **실매매 연관 서비스**: `ai.investment.commander`는 C그룹이지만 실투자 중이므로 선결 조건 충족 전 절대 전환 금지
- **Hub 바인딩 이슈(SEC-001)와의 관계**: hub_resource_api는 C그룹. 보안 Task 1(0.0.0.0→127.0.0.1) 패치 먼저 반영 후 C그룹 조건부 전환 검토
