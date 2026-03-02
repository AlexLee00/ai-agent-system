# 시스템 개선 아이디어

## 아키텍처 개선안

### 1. n8n 대신 또는 병행 고려: OpenClaw 네이티브 오케스트레이션
- OpenClaw 자체에 멀티 에이전트 기능이 있으므로 n8n 의존도를 낮출 수 있음
- n8n은 외부 API 연동 트리거 용도로만 한정하는 방식도 유효

### 2. 모델 공유 전략 (메모리 최적화)
- qwen2.5:32b가 메인봇 + 업무봇에서 동시 사용 → 실제로는 동일 모델 인스턴스 공유 가능
- Ollama의 모델 로딩 방식상 동시에 두 봇이 같은 모델 요청 시 대기 발생
- 해결책: 메인봇과 업무봇 요청을 큐잉(queue)하여 순차 처리하거나, 업무봇은 14b로 다운그레이드 고려

### 3. deepseek-r1:32b 2개 동시 운용 문제
- 학술봇 + 판례봇 모두 deepseek-r1:32b → 동시 실행 시 40GB 차지
- 두 봇이 동시에 실행될 가능성 낮지만 메모리 주의
- 해결책: 학술봇/판례봇은 동일 모델 인스턴스 공유, 요청 큐 관리

### 4. 스카 봇 안정성 (95%)

#### ✅ 완료
- ✅ Heartbeat (1시간 주기, 09:00~22:00 텔레그램 전송)
- ✅ log-report.sh (3시간 주기 오류 분석 + 텔레그램 리포트)
- ✅ start-ops.sh 자동 재시작 루프
- ✅ 리스트 기반 취소 감지 (previousConfirmedList + 취소 탭 이중 확인)
- ✅ pickko-verify.js (pending/failed 재검증 + 자동 등록, --dry-run 지원)
- ✅ lib/ 공유 라이브러리 리팩토링 (utils/secrets/formatting/files/args/browser/pickko)

#### 📋 업데이트 검토 (미구현)
- 📋 **IS-001** 네이버 홈화면 복귀 이슈 — session/cookie 만료 처리 개선 (낮은 우선순위)
- ✅ **pickko-verify.js 자동 스케줄링** — launchd ai.ska.pickko-verify (08:00/14:00/20:00) 완료
- ✅ **일일 예약 요약 자동 전송** — `pickko-daily-summary.js` 완료 (2026-02-26): 09:00 예약현황 / 00:00 마감 매출+컨펌 launchd 자동화
- 📋 **예약 중복 감지 알림** — 동일 시간대 중복 예약 발생 시 즉시 경고
- 📋 **맥미니 이전** — M4 Pro 구매 후 전체 시스템 이전 (Phase 3)
- 📋 **Playwright → 네이버 API 직접 호출** — UI 변경 취약점 근본 해결 (장기, 검토 중)

#### 🗂️ 개발 예정 — 스카 기능 확장 (2026-02-25 등록, 우선순위 확정)

| 순위 | 항목 | 상태 | 비고 |
|------|------|------|------|
| 1 | 텔레그램 알람 불가 처리 | ✅ 완료 (2026-02-26) | pending-telegrams.jsonl + flushPendingTelegrams() |
| 2 | 텔레그램 자연어 명령 개선/테스트 | ✅ 완료 (2026-02-26) | 매출통계 추가 + E2E 27케이스 100% 통과 |
| 3 | 키오스크 취소 → 네이버 예약불가 자동 해제 | ✅ 완료 (2026-02-26) | pickko-kiosk-monitor.js Phase 2B+3B |
| 4 | 픽코 예약 취소 자동화 | ✅ 완료 (2026-02-24) | pickko-cancel.js [1-10단계] |
| 5 | 픽코 키오스크 이용권 추가 | ✅ 완료 (2026-02-27) | pickko-ticket.js 9단계 자동화 |
| 6 | 픽코 회원 이름 수정 | ✅ 완료 (2026-02-26) | pickko-accurate.js [1.5단계] syncMemberNameIfNeeded() |

**상세:**
- ✅ **[1] 텔레그램 알람 불가 처리** — 완료 (2026-02-26)
  - `lib/telegram.js` `savePending()`: 3회 재시도 최종 실패 시 `pending-telegrams.jsonl` append
  - `flushPendingTelegrams()` 신규: 재시작 시 대기큐 순차 재발송, 성공 항목 제거
  - `naver-monitor.js` 시작 시 `await flushPendingTelegrams()` 추가 (Puppeteer 실행 전)
- ✅ **[2] 텔레그램 자연어 명령 기능 개선 및 테스트** — 완료 (2026-02-26)
  - pickko-stats-cmd.js 신규 — 날짜/주/월/누적 매출 통계 조회 (--date/--period/--month/--cumulative)
  - pickko-query.js — 예약 조회 (날짜/이름/번호/룸 필터)
  - pickko-register.js — 예약 등록 자연어 래퍼
  - pickko-cancel-cmd.js — 예약 취소 자연어 래퍼
  - test-nlp-e2e.js — E2E 테스트 27케이스 100% 통과
  - CLAUDE_NOTES.md 자연어 명령 전체 매핑 테이블 통합
- ✅ **[3] 키오스크 예약 취소 시 네이버 예약불가 자동 해제** — `pickko-kiosk-monitor.js` Phase 2B+3B 완성 (2026-02-26)
  cancelledEntries 감지 → unblockNaverSlot (clickRoomSuspendedSlot → fillAvailablePopup → verifyBlockInGrid)
- ✅ **[4] 픽코 예약 취소 자동화** — `pickko-cancel.js` [1-10단계] 완성 (2026-02-24)
  [6-B단계] 0원/이용중 폴백, [7-B단계] 결제대기 폴백 포함
- ✅ **[5] 픽코 키오스크 이용권 추가 기능** — `pickko-ticket.js` 완료 (2026-02-27)
  9단계 자동화 + `--discount` 전액할인 / `--reason` 주문메모 / 기간권 중복 방지
- ✅ **[6] 픽코 회원 이름 수정 기능** — `pickko-accurate.js` [1.5단계] `syncMemberNameIfNeeded()` 완성 (2026-02-26)
  study/write 모달 li[mb_no] 추출 → 통합 타입 스킵 → "회원 정보 수정" 버튼으로 이름 수정

### 5. 주식투자봇 데이터 파이프라인
- KIS Developers 실시간 주가는 웹소켓 연결 필요 → PM2로 상시 유지 권장
- DART 공시는 polling 방식 → n8n 스케줄 트리거로 구현 적합

### 6. RAG 분리 전략
- 봇별 ChromaDB 컬렉션 분리 → 검색 정확도 향상
- 공통 컬렉션(시스템 문서)은 메인봇이 접근
- 투자 데이터와 논문 데이터는 민감도/성격이 달라 반드시 분리

### 7. 모니터링 우선순위
- Phase 5로 미뤄진 Grafana/Loki → Phase 2 말에 최소 구성 권장
- 봇이 많아질수록 장애 원인 파악이 어려워짐

## 전체 개발 백로그 (2026-02-27 확정)

### 🔴 즉시 안정화 (ST) — 운영 리스크

| # | 항목 | 우선순위 | 상태 |
|---|------|---------|------|
| ST-001 | state.db 자동 백업 (launchd 일일) | 🔴 긴급 | ✅ 완료 (2026-02-27) |
| ST-002 | BUG-006 해결 — BOOT 후 파일명 텔레그램 출력 | 🔴 긴급 | ✅ 완료 (2026-02-27) |
| ST-003 | launchd 서비스 다운 감지 + 텔레그램 알림 | 🔴 높 | ✅ 완료 (2026-02-27) |
| ST-004 | IS-001 — 네이버 홈화면 복귀 세션 자동 재개 | 🟠 중 | ⏭️ 스킵 (기존 코드에 이미 상당 부분 구현됨) |
| ST-005 | 예약 변경(시간 수정) 감지 및 처리 | 🟠 중 | ⏭️ 스킵 (복잡도 높음, 자동 취소 오작동 리스크) |

### 🟠 단기 기능 (FE) — 1~2개월

| # | 항목 | 우선순위 | 상태 |
|---|------|---------|------|
| FE-001 | 예약 중복 감지 알림 | 🟠 중 | ⏭️ 스킵 (네이버·픽코 자동 연동으로 중복 발생 거의 없음) |
| FE-002 | 룸별·시간대별 가동률 리포트 | 🟠 중 | ✅ 완료 (2026-02-27) |
| FE-003 | 블랙리스트 고객 관리 | 🟡 낮 | ⏭️ 스킵 |
| FE-004 | 노쇼(No-show) 감지 | 🟡 낮 | ⏭️ 스킵 |
| FE-005 | 로그 rotation (naver-ops-mode.log) | 🟠 중 | ✅ 완료 (2026-02-27) |
| FE-006 | gemini-2.5-flash execute_tool 누출 버그 재테스트 | 🟠 중 | ✅ 완료 (2026-02-27) — 미재현, 버그 종결 |
| FE-007 | 아이패드 SSH 환경 개선 — mosh 전환 검토 | 🟡 낮 | ✅ 완료 (2026-02-27) — mosh 설치, 검토 결과 정리 |
| FE-008 | Claude Code 한글 wide char 버그 — Anthropic GitHub 이슈 등록 | 🟡 낮 | ✅ 완료 (2026-02-27) — #15705 코멘트 추가 |
| FE-009 | health-check.js naver-monitor 로그 staleness 체크 추가 | 🟡 낮 | ✅ 완료 (2026-02-27) |

### FE-007: 아이패드 SSH 환경 개선 ✅ (2026-02-27)
- rlwrap 시도 → Claude Code TUI 레이어에서 효과 없음 확인
- 근본 원인: Claude Code Ink 프레임워크 한글 wide char 렌더링 버그 (transport 무관)
- **mosh 설치 완료**: `brew install mosh` (1.4.0) + `~/.zprofile` PATH 설정
- **한글 입력 개선 효과 없음** — mosh는 transport 레이어, Ink TUI 버그는 클라이언트 사이드
- **mosh 실제 이점**: WiFi↔LTE 전환 시 세션 유지, 네트워크 불안정 환경에서 연결 복구
- **방화벽**: 현재 비활성화 → UDP 60000-61000 별도 설정 불필요
- **Termius mosh 지원**: 공식 문서에는 지원 명시, 실제 동작은 직접 테스트 필요
- **테스트 방법**: Termius 호스트 설정 → Connection Type: mosh → 접속 시도

### FE-008: Claude Code 한글 wide char 버그 GitHub 이슈 등록 ✅ (2026-02-27)
- 기존 이슈 #15705 발견 (OPEN, labels: area:tui, bug, has repro, platform:ios)
- 코멘트 추가: https://github.com/anthropics/claude-code/issues/15705#issuecomment-3971394180
  - macOS 로컬(iTerm2)에서도 미미하게 재현 확인 추가
  - rlwrap·mosh 무효 확인 (TUI 레이어 버그, transport 무관)
  - Root cause 가설: Ink TUI가 한글 syllable을 1칸으로 계산 → 커서 오정렬

### FE-009: health-check.js naver-monitor 로그 staleness 체크
- 현재: PID 존재 여부만 확인 (KeepAlive라 PID 없는 순간이 매우 짧음)
- 개선: naver-ops-mode.log 마지막 기록 시간 확인 → 15분 이상 무활동이면 경고
- 효과: 크래시루프(재시작 반복) 상태를 더 빠르게 감지

### 🟡 중기 기능 (MD) — 3~6개월

| # | 항목 | 우선순위 | 상태 |
|---|------|---------|------|
| CL-003 | ska 매출예측 시스템 (설계 완료) | 🟠 높 | 📋 대기 |
| CL-004 | Dev/OPS 분리 방안 검토 | 🟡 중 | 📋 대기 |
| MD-003 | VIP 고객 인식 + 자동 태그 | 🟡 낮 | 📋 대기 |
| MD-004 | 재방문율·취소율 트렌드 주간 리포트 | 🟡 낮 | 📋 대기 |
| MD-005 | 성수기/비수기 가격 최적화 제안 | 🟡 낮 | 📋 대기 |
| CL-006 | 코딩가이드 기준 전체 코드 리팩토링 | 🟡 중 | 📋 대기 |
| MD-006 | ska 선행 — data.go.kr 무료 API 키 발급 4종 | 🟠 높 | ✅ 완료 (사용자 신청 대기) |

### MD-006: ska 선행 — data.go.kr API 키 발급 ✅ 완료 (2026-02-27)
- ska 이브(EVE) 개발 전 반드시 선행 필요
- secrets.json에 플레이스홀더 추가 완료 (사용자가 키 발급 후 채워넣기)
- 발급 대상 (전원 무료·즉시승인, https://www.data.go.kr):

| API | secrets.json 키 | 엔드포인트 | data.go.kr ID |
|-----|----------------|-----------|--------------|
| 한국천문연구원 특일정보 | `datagokr_holiday_key` | `http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getAnniversaryInfo` | 15012690 |
| 기상청 단기예보 | `datagokr_weather_key` | `http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0` | 15084084 |
| 교육부 NEIS 학사일정 | `datagokr_neis_key` | `http://open.neis.go.kr/hub/scheduleInfo` | 15137088 |
| 전국문화축제표준데이터 | `datagokr_festival_key` | `http://api.data.go.kr/openapi/tn_pubr_public_cltur_fstvl_api` | 15013104 |

- **이브(EVE) 연동 메모:**
  - 성남시 분당구 기상 격자: nx=62, ny=122
  - 학사일정 경기도 코드: ATPT_OFCDC_SC_CODE=J10 (경기도교육청)
  - 축제 필터: 성남시 필터링 가능 (지역명 파라미터)

### 🟢 장기/검토 (LT) — 맥미니 이전 후

| # | 항목 | 우선순위 | 상태 |
|---|------|---------|------|
| CL-005 | 에이전트 활동 GUI 도입 여부 검토 | 🟢 낮 | 📋 대기 |
| LT-002 | Playwright → 네이버 API 직접 호출 | 🟢 낮 | 📋 대기 |
| LT-003 | 다른 봇팀 개발 (secretary/business/academic 등) | 🟢 낮 | 📋 대기 |
| LT-004 | ChromaDB RAG — 예약 패턴 벡터 저장 | 🟢 낮 | 📋 대기 |

### ✅ 완료

| # | 항목 | 완료일 |
|---|------|--------|
| CL-001 | 작업 히스토리 파일 생성 | 2026-02-27 |
| CL-002 | 코딩가이드 최신화 | 2026-02-27 |

### CL-001: 작업 히스토리 파일 생성
- 세션별 주요 작업을 단일 타임라인으로 볼 수 있는 `memory/work-history.md` 신규
- HANDOFF.md(봇 중심) + session-close 로그를 통합한 날짜별 히스토리
- 빠른 "지난 주에 뭐 했지?" 파악용

### CL-002: 코딩가이드 최신화
- **기술스택**: Node.js v24, Playwright, SQLite(better-sqlite3), launchd, OpenClaw 패턴 정리
- **모델 관련**: 각 모델별 특성/성능/비용 비교표, 선택 기준 가이드
- **OpenClaw + LLM 연동**: BOOT 최적화 패턴, 인라인 컨텍스트 전략, tool 호출 최적화, 모델별 quirks (gemini-2.5-flash thinking=low 등)
- 국내외 커뮤니티(Reddit, HN, 한국 개발 커뮤니티) 서칭하여 검증된 베스트 프랙티스 반영
- 참고: `memory/coding-guide.md` 기존 파일 업데이트

### CL-003: ska 매출예측 시스템 개발
**설계 확정**: 2026-02-27 → 상세 설계: `memory/ska-design.md`
**목표**: 스터디카페 매출 예측 — 일/주/월 예상 매출 텔레그램 자동 리포트

**팀 구성 (확정)**:
- 🟢 **스카** — 예약수집 + ETL(피코-DC 흡수) + 오케스트레이터 + 텔레그램
- 🟣 **이브(EVE)** — 공공API 환경 데이터 수집 → Prophet regressor 값 생성
- 🔵 **레베카(REBECCA)** — pandas 현황 분석 + 이상 감지 + DuckDB 저장
- 🟠 **포캐스트(FORECAST)** — Prophet 예측 엔진 + 이브 regressor 연동

**기술 스택 (확정)**:
- 예측 엔진: Prophet (statsmodels 대비 소규모 데이터 + 계절성 우위)
- DB: SQLite(예약 트랜잭션) + DuckDB(분석·예측 집계)
- 외부 데이터: data.go.kr 무료 API 4종 + 큐넷/수능 크롤링
- 오케스트레이션: launchd 스케줄링

**개발 단계 (순서대로)**:

| # | 작업 | 난이도 | 상태 |
|---|------|--------|------|
| ska-001 | DuckDB 설치 및 스키마 생성 | ⭐ | ✅ 완료 (2026-02-27) |
| ska-002 | 스카 ETL 모듈 (SQLite→DuckDB) | ⭐⭐ | ✅ 완료 (2026-02-27) |
| ska-003 | 이브 공공API 연동 (공휴일+날씨+NEIS) | ⭐ | ✅ 완료 (2026-02-27) |
| ska-004 | 레베카 일간 현황 리포트 | ⭐⭐ | ✅ 완료 (2026-02-27) |
| ska-005 | 이브 크롤링 (큐넷+수능) | ⭐⭐ | ✅ 완료 (2026-02-27) |
| ska-006 | 포캐스트 Prophet 기본 엔진 | ⭐⭐⭐ | ✅ 완료 (2026-02-27) |
| ska-007 | 포캐스트 이브 regressor 연동 | ⭐⭐⭐ | ✅ 완료 (2026-02-27) |
| ska-008 | launchd 스케줄링 전체 연결 | ⭐⭐ | ✅ 완료 (2026-02-27) |

### CL-004: Dev/OPS 분리 방안 필요성 검토
- 현재 동일 코드베이스에서 개발/운영 동시 진행 → 미완성 코드가 OPS에 영향 줄 수 있음
- 검토 사항:
  - git branch 전략 (main=OPS, dev=개발)
  - launchd 서비스 이중화 (ops-port 18789 / dev-port 18790 분리 운영)
  - 환경변수 `.env.ops` / `.env.dev` 분리
  - BOOT.md 자동 생성 시 dev/ops 분기 처리
- 결론 도출 후 구현 여부 결정

### CL-005: 에이전트 활동 GUI 도입 여부 검토
- 현재: 로그 파일 + 텔레그램 알림으로만 활동 파악
- 검토 대상:
  - **OpenClaw 자체 대시보드** 기능 유무 확인
  - **Grafana + Loki** 경량 구성 (Phase 5에서 검토 예정이었으나 앞당기기)
  - **커스텀 웹 UI** (Express + SSE) — 봇별 최근 활동, 예약 현황, 매출 요약
  - **n8n 모니터링 탭** 활용
- 맥미니 이전 후 리소스 여유가 생기면 본격 검토

### CL-006: 코딩가이드 기준 전체 코드 리팩토링
**목표**: `docs/coding-guide.md`에 정의된 원칙을 기존 코드에 소급 적용하여 일관성 확보

**리팩토링 체크 항목:**
- **Security by Design**
  - `loadSecrets(requiredKeys)` 강제 검증 패턴 미적용 파일 적용
  - 로그 마스킹 (`maskPhone`, `maskKey`, `maskEmail`) 누락 부분 추가
  - 입력 검증 누락 (`validateDate`, `validateRoomId` 등) 경계값 보완
- **모듈 통일**
  - `lib/cli.js` (`outputResult`, `fail`) 미사용 src 파일 전환
  - `lib/args.js` (`parseArgs`) 자체 구현 남은 파일 전환
  - `lib/utils.js` (`delay`, `log`) 인라인 중복 제거
- **에러 처리**
  - `try/catch` 누락된 Playwright 호출 보완
  - exit code 불일치 (`process.exit(0)` vs 실패 흐름) 점검
- **코드 일관성**
  - 함수명·변수명 네이밍 컨벤션 (`camelCase`, 동사+명사) 통일
  - 주석 언어 혼재 (영어/한국어) 정리 — 한국어 주석으로 통일
  - `const` vs `let` 오용 정리

**대상 파일 (우선순위 순):**
1. `src/naver-monitor.js` — 가장 복잡, 핵심 로직
2. `src/pickko-accurate.js` — 픽코 자동 등록 메인
3. `src/pickko-cancel.js` — 취소 플로우
4. `src/pickko-kiosk-monitor.js` — 키오스크 모니터
5. `src/pickko-daily-summary.js`, `src/pickko-daily-audit.js`
6. 나머지 src/*.js 전체

**진행 방식**: 파일 단위로 순차 진행, 기능 변경 없이 구조 개선만

---

## 개발 우선순위 제안
1. 스카 봇 안정화 완성 (현재 90%)
2. 맥미니 기본 인프라 (Ollama + n8n + Docker + Tailscale)
3. 메인봇 (오케스트레이터 먼저 → 나머지 봇 연결 기반)
4. 개인비서봇 (일상 유용성 높음)
5. 주식투자봇 (시장 데이터는 타이밍 중요)
6. 업무봇
7. 학술봇 + 판례봇 (RAG 인프라 선행 필요)

## 클로드 작업 백로그 전체 우선순위 (2026-03-02 개정)

> **지침**: 맥미니 이전 전까지 맥북 환경에서 스카·루나·클로드·메인봇 구현 및 테스트·안정화 완료
> 성과 리포트(reporter.js)는 향후 매매일지 활용 예정 — 지금은 OPS 전환 전 테스트 데이터 수집 목적

| 순위 | 항목 | 상태 | 비고 |
|------|------|------|------|
| 1 | **CL-003 ska-001~008** | ✅ 완료 | |
| 2 | **CL-007 아처 봇** | ✅ 완료 (2026-03-01) | |
| 3 | **LU-001~LU-009** | ✅ 완료 (2026-03-01) | Phase 0 드라이런 |
| 4 | **SKA-P01~P08** | ✅ 완료 (2026-03-02) | 루나→스카 패턴 이식 |
| 5 | **LU-020~LU-021** | ✅ 완료 (2026-03-02) | 다중심볼+KIS 6지표 |
| 6 | **LU-035** | ✅ 완료 (2026-03-02) | 강세/약세 리서처 |
| 7 | **LU-022/024 reporter.js** | ✅ 완료 (2026-03-02) | 일/주/월 성과 리포트 |
| 8 | **LU-030 펀드매니저** | ✅ 완료 (2026-03-02) | claude-haiku-4-5-20251001, JSON파싱 안정화 |
| 9 | **LU-036 리스크 매니저 v2** | ✅ 완료 (2026-03-02) | ATR·상관관계·시간대·LLM 4단계 |
| 10 | **LU-037 백테스팅 엔진** | ✅ 완료 (2026-03-02) | 4심볼 1d/4h, 텔레그램 리포트 |
| 11 | **LU-038 몰리 v2 TP/SL** | ✅ 완료 (2026-03-02) | upbit-bridge.js ±3% 자동 청산 |
| 12 | **CL-004** Dev/OPS 분리 | ✅ 완료 (2026-03-02) | mode.js + health.js + switch-to-ops.sh |
| 13 | **취소 감지 교차검증** | ✅ 완료 (2026-03-02) | currentCancelledList 비교, 이용완료 추정 스킵 |
| 14 | **LLM 비용 최적화** | ✅ 완료 (2026-03-02) | sonnet→haiku, 스케줄 최적화, debate 제한 |
| 15 | **LU-039 ChromaDB 학습 루프** | 📋 맥북 | 장기 누적 학습 |
| 16 | **LU-025** OPS 전환 | 📋 **맨 마지막** | 맥북 안정화 완료 후 |
| 17 | **CL-005** GUI / 맥미니 이전 | 📋 Phase 2 | 맥미니 구매 후 |
| 18 | **CL-006** 코드 리팩토링 | 📋 맥북 | 기능 안정화 후 |

### SKA-P01~P08: 루나팀 → 스카팀 패턴 적용 (2026-03-02)

| # | 코드 | 패턴 | 대상 파일 | 상태 |
|---|------|------|-----------|------|
| ① | SKA-P01 | DB 마이그레이션 시스템 | `scripts/migrate.js` + `migrations/` | ✅ 완료 (2026-03-01) |
| ② | SKA-P02 | Secrets 폴백 전략 | `lib/secrets.js` | ✅ 완료 (2026-03-01) |
| ③ | SKA-P03 | Start Script 2중 검증 | `scripts/preflight.js` + `start-ops.sh` | ✅ 완료 (2026-03-01) |
| ④ | SKA-P04 | 텔레그램 도메인 포매터 | `lib/telegram.js` | ⏭️ 스킵 |
| ⑤ | SKA-P05 | 연속 오류 카운터 | `lib/error-tracker.js` | ✅ 완료 (2026-03-02) |
| ⑥ | SKA-P06 | E2E 통합 테스트 | `scripts/e2e-test.js` (28/28) | ✅ 완료 (2026-03-02) |
| ⑦ | SKA-P07 | 모드/환경 분리 | `lib/mode.js` | ✅ 완료 (2026-03-02) |
| ⑧ | SKA-P08 | 프로세스 상태 파일 | `lib/status.js` + `/tmp/ska-status.json` | ✅ 완료 (2026-03-02) |

---

## 클로드팀 개선 / 추가 개발 내역 (2026-03-01)

### CL-007: 아처(Archer) 봇 구현 완료 ✅ (2026-03-01)

**목적**: 주간 기술스택·LLM·시장 동향 자동 분석 리포트

**구현 파일:**

| 파일 | 설명 |
|------|------|
| `bots/claude/lib/archer/config.js` | API URL, 임계값, 출력 경로 설정 |
| `bots/claude/lib/archer/fetcher.js` | GitHub Releases·npm·Binance·FearGreed 수집 |
| `bots/claude/lib/archer/store.js` | archer-cache.json 읽기/쓰기 |
| `bots/claude/lib/archer/analyzer.js` | Claude API 호출 → JSON 분석 결과 반환 |
| `bots/claude/lib/archer/reporter.js` | 마크다운 리포트 빌드 + 텔레그램 요약 발송 |
| `bots/claude/src/archer.js` | 메인 오케스트레이터 (lock → fetch → analyze → report → save) |
| `~/Library/LaunchAgents/ai.claude.archer.plist` | 매주 월요일 09:00 KST 자동 실행 |

**버그 수정 2건:**
- `max_tokens: 2048 → 4096` — 한국어 JSON 응답 중간 절단 방지
- GitHub URL 3개 수정: `anthropic-sdk-python`, `groq-typescript`, `js-genai` (기존 404 오류)

**첫 실행 결과:**
- `bots/claude/reports/archer-2026-03-01.md` 생성 성공
- Claude 분석: priority_updates 5건, market_insight, llm_trends, trading_tech, action_items 정상 출력

---

## OpenClaw 개선 백로그 (OC-001~009)

> 출처: 2026-03-02 공식문서(docs.openclaw.ai) 검토 결과
> 상세: `memory/dev-journal.md` 2026-03-02 항목

| # | 코드 | 내용 | 우선순위 | 상태 |
|---|------|------|---------|------|
| 1 | OC-001 | qwen2.5:7b 샌드박스 격리 또는 웹도구 제거 (CRITICAL) | 🔴 긴급 | ✅ 완료 (2026-03-02) |
| 2 | OC-002 | `denyCommands` 잘못된 명령어명 수정 (무효 6개 제거 → `canvas.eval` 교체) | 🟠 중 | ✅ 완료 (2026-03-02) |
| 3 | OC-003 | `botToken` SecretRef 전환 (plaintext→파일/env 참조) | 🟠 중 | ✅ 완료 (2026-03-02) |
| 4 | OC-004 | `ackReaction` 활성화 (DM 수신 확인 이모지) | 🟡 낮 | ✅ 완료 (2026-03-02) |
| 5 | OC-005 | `session.reset.daily: true` 설정 (매일 컨텍스트 초기화) | 🟡 낮 | ✅ 완료 (2026-03-02) |
| 6 | OC-006 | `session.dmScope` 설정 — DM은 스카팀만, 나머지 그룹만 | 🟡 낮 | ✅ 완료 (2026-03-02) |
| 7 | OC-007 | `agents.list` 멀티에이전트 협업 설정 (스카↔루나 채널 공유) | 🟢 장기 | ⏭️ 스킵 |
| 8 | OC-008 | `$include` 분리 — 팀별 config 분산 관리 | 🟢 장기 | ⏭️ 스킵 |
| 9 | OC-009 | Cerebras/SambaNova auth profile 등록 (현재 "configured,missing") | 🟠 중 | ✅ 완료 (2026-03-02) |

**OC-007 스킵 사유**: 루나팀은 standalone Node.js (OpenClaw 미기반) → 현재 에이전트 간 채널 공유 불필요. 맥미니 이전(Phase 2) 후 루나팀 OpenClaw 전환 시 재검토.

**OC-008 스킵 사유**: 현재 openclaw.json 약 180행 — $include 분리 시 관리 복잡도만 증가. 500행 초과 시 재검토.

**OC-009 조치 완료 (2026-03-02)**: `cerebras/llama-3.3-70b`, `sambanova/Meta-Llama-3.3-70B-Instruct`, `sambanova/DeepSeek-V3-0324` → agents.defaults.models에서 제거. `cerebras/llama3.1-8b` 유지 (configured 상태). 재등록: API 키 발급 후 auth-profiles.json에 `{ type: "api_key", provider: "cerebras"/"sambanova", key: "..." }` 추가.

**OC-001 조치 완료 (2026-03-02)**:
- qwen2.5:7b를 `agents.defaults.model.fallbacks`에서 제거
- `agents.defaults.models` 목록에서도 제거
- fallback 체인: gemini-2.5-flash → claude-haiku-4-5 (1단계로 단순화)
- `openclaw security audit` 재실행 → CRITICAL 없음 확인
- `models.providers.ollama` 정의는 유지 (RAG 직접 호출 가능)

**OC-003 상세**:
- 현재 `openclaw.json`에 `telegram_bot_token` plaintext 저장
- 개선: `SecretRef { file: "~/.openclaw/secrets/telegram.txt" }` 전환

**속도테스트기 프로바이더 현황 (2026-03-02)**:

| 프로바이더 | 상태 | API 키 | 속도테스트 |
|-----------|------|--------|----------|
| google-gemini-cli | ✅ OAuth 등록 | OAuth | ✅ 구현 |
| ollama | ✅ 로컬 | 불필요 | ✅ 구현 |
| openai | ✅ 프로파일 등록 | auth-profiles | ✅ 구현 |
| groq | ✅ 키 등록 | speed-test-keys | ✅ 구현 |
| cerebras | ⚠️ 키 미등록 | speed-test-keys | ✅ 구현 (키 없으면 스킵) |
| sambanova | ⚠️ 키 미등록 | speed-test-keys | ✅ 구현 (키 없으면 스킵) |
| openrouter | ⚠️ 키 미등록 | speed-test-keys | ✅ 구현 (키 없으면 스킵) |
| xai | 📋 미등록 | - | 📋 리스트만 등록 |
| mistral | 📋 미등록 | - | 📋 리스트만 등록 |
| together | 📋 미등록 | - | 📋 리스트만 등록 |
| fireworks | 📋 미등록 | - | 📋 리스트만 등록 |
| deepinfra | 📋 미등록 | - | 📋 리스트만 등록 |

---

## 루나팀 개발 백로그

### LU-001~LU-008: Phase 0 드라이런 기본 구현 ✅ (2026-03-01)

**구현 내역:**

| # | 파일 | 역할 | 상태 |
|---|------|------|------|
| LU-001 | `bots/invest/package.json` | 의존성 (ccxt, duckdb) | ✅ |
| LU-002 | `bots/invest/lib/secrets.js` | API 키 로드 + 드라이런 감지 | ✅ |
| LU-003 | `bots/invest/lib/db.js` | DuckDB 연결 + 스키마 초기화 | ✅ |
| LU-004 | `bots/invest/lib/binance.js` | CCXT Binance 클라이언트 (spot, testnet) | ✅ |
| LU-005 | `bots/invest/lib/upbit.js` | CCXT Upbit 클라이언트 | ✅ |
| LU-006 | `bots/invest/lib/signal.js` | 신호 타입 정의 | ✅ |
| LU-007 | `bots/invest/lib/telegram.js` | 텔레그램 알림 (reservation 패턴 재사용) | ✅ |
| LU-008 | `bots/invest/src/analysts/ta-analyst.js` | RSI/MACD/볼린저밴드 계산 | ✅ |
| LU-009 | `bots/invest/src/analysts/signal-aggregator.js` | TA 집계 + Claude LLM 판단 | ✅ |
| LU-010 | `bots/invest/src/risk-manager.js` | 규칙 기반 승인/거부 (포지션 20%, 일손실 5%) | ✅ |
| LU-011 | `bots/invest/src/binance-executor.js` | 바이낸스 Spot 주문 실행 (드라이런) | ✅ |
| LU-012 | `bots/invest/src/upbit-bridge.js` | 업비트 잔고 모니터링 + 전송 (드라이런) | ✅ |
| LU-013 | `bots/invest/scripts/setup-db.js` | DB 스키마 초기화 CLI | ✅ |
| LU-014 | `bots/invest/scripts/dry-run-test.js` | 전체 흐름 테스트 (9/9 통과) | ✅ |
| LU-015 | `~/Library/LaunchAgents/ai.invest.dev.plist` | DEV 드라이런 파이프라인 (10분 주기) | ✅ |

**드라이런 테스트 결과 (2026-03-01):**
- 9/9 단계 모두 통과
- BTC/USDT, ETH/USDT 각각 HOLD 신호 (RSI 중립, MACD 음전환 — 시장 대기 상황 정상)
- DB 저장 정상, 텔레그램 알림 정상

**DEV 모드 운영 설정:**
- `ai.invest.dev.plist`: `INVEST_MODE=dev`, `DRY_RUN=true`, 10분 주기
- OPS plist(pipeline/bridge)는 실 API 키 준비 시까지 언로드 상태

---

### 루나팀 Phase 1 고도화 백로그 (단기 — 데이터 누적 후)

| # | 항목 | 우선순위 | 상태 |
|---|------|---------|------|
| LU-020 | 다중 심볼 지원 (BTC/ETH 외 SOL, BNB 추가) | 🟠 중 | 📋 대기 |
| LU-021 | TA 지표 고도화 (이평정배열 5/10/20/60/120 추가) | 🟠 중 | 📋 대기 |
| LU-022 | 신호 히스토리 분석 — 드라이런 성과 추적 | 🟠 중 | 📋 대기 (30일 데이터 누적 후) |
| LU-023 | 공포탐욕지수 통합 (온체인 분석 선행) | 🟡 낮 | 📋 대기 |
| LU-024 | 일일 22:00 성과 리포트 텔레그램 자동 발송 | 🟡 낮 | 📋 대기 |
| LU-025 | 바이낸스 API 키 등록 → OPS 모드 전환 | 🔴 필수 | 📋 OPS 전환 시 |

---

### 루나팀 v2.0 전체 구축 백로그 (Phase 3 — 맥미니 없이 진행, 2026-03-02 결정)

> 상세 설계: `docs/SYSTEM_DESIGN.md §5-3`
> Gemini API는 스카팀 전용 — 루나팀 사용 불가

#### LLM 정책 (2026-03-02 확정, 운영하면서 변경 검토)

| 봇 | LLM 필요 여부 | 근거 |
|----|--------------|------|
| 뉴스분석가, 감성분석가 | ✅ 필수 | 자연어 이해 없이 감성 파악 불가 |
| 강세/약세 리서처 | ✅ 필수 | 다관점 추론 자체가 LLM 역할 |
| 루나 펀드매니저 | ✅ 필수 | 복합 신호 종합 판단 |
| 온체인분석가 | ❌ 선택적 | 규칙 기반으로 90% 커버, Groq 있으면 사용 |
| 몰리 v2 (TP/SL) | ❌ 불필요 | 수식 기반 (진입가×1.03 익절, ×0.97 손절) |
| 백테스팅 엔진 | ❌ 선택적 | 수치 계산은 규칙 기반, 전략 해석만 선택적 LLM |

#### LLM 임시 배정 (맥미니 구매 전) — 운영 후 조정 예정

| # | 항목 | 담당 봇 | 임시 LLM | 최종 LLM (맥미니 후) | 상태 |
|---|------|--------|---------|-------------------|------|
| LU-030 | 루나 펀드매니저 오케스트레이터 | 루나 | claude-haiku-4-5-20251001 | claude-haiku-4-5 | ✅ 완료 (2026-03-02) |
| LU-031 | 제이슨 v2 기술분석 고도화 | 제이슨 v2 | claude-haiku-4-5 | groq/llama-3.3-70b | ✅ 완료 |
| LU-032 | 감성분석가 (Reddit/DCInside) | 새 봇 | groq/llama-3.3-70b | groq/llama-3.3-70b | ✅ 완료 |
| LU-033 | 온체인분석가 (펀딩비/공포탐욕/L/S) | 새 봇 | Groq (규칙 기반 fallback) | Groq (규칙 기반 fallback) | ✅ 완료 |
| LU-034 | 뉴스분석가 (CoinDesk/코인텔레그래프) | 새 봇 | groq/llama-3.1-8b-instant | groq/llama-3.1-8b | ✅ 완료 |
| LU-035 | 강세/약세 리서처 토론 엔진 | 새 봇 ×2 | claude-haiku-4-5 | claude-haiku-4-5 | ✅ 완료 (2026-03-02) |
| LU-036 | 리스크 매니저 v2 (LLM 강화) | 업그레이드 | claude-haiku-4-5 | claude-haiku-4-5 | ✅ 완료 (2026-03-02) |
| LU-037 | 백테스팅 엔진 | 새 봇 | 규칙 기반 | ollama/deepseek-r1:32b | ✅ 완료 (2026-03-02) |
| LU-038 | 몰리 v2 업비트 TP/SL | 업그레이드 | LLM 없음 | LLM 없음 | ✅ 완료 (2026-03-02) |
| LU-039 | ChromaDB 학습 루프 | 루나 | - | - | 📋 맥미니 이전 후 |
