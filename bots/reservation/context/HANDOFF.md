# 스카 (Ska) - 최신 인수인계

> **스카** = 스터디카페 예약관리봇 | **클로드** = Claude Code (AI 개발 파트너)
> 이 파일은 모델 교체/재시작 시 가장 최근 상태를 빠르게 파악하기 위한 인수인계 문서입니다.
> 새로운 작업이 완료될 때마다 업데이트하세요.
> 아래 이력 구간의 `.js` 경로 표기는 당시 작업 기준 기록일 수 있습니다. 현재 운영 엔트리는 기본적으로 `dist/ts-runtime/.../*.js`, 소스 기준은 `.ts`, non-dist `.js`는 대부분 `.legacy.js` 호환 레일만 남아 있습니다.

---

## 현재 운영 상태

| 항목 | 내용 |
|------|------|
| 모드 | OPS (운영) |
| 모델 | google-gemini-cli/gemini-2.5-flash |
| 채널 | 텔레그램 (@SCAFE8282_BOT) |
| 모니터 | 자동 재시작 루프 (2시간 주기) |

---

## 🐛 이슈 & 버그 추적

> 자동 관리: `dist/ts-runtime/.../bug-report.js` 실행 시 갱신 | 수동 등록: `node dist/ts-runtime/bots/reservation/src/bug-report.js --new --title "..." --by ska`

<!-- bug-tracker:issues:start -->
| 상태 | 심각도 | ID | 제목 | 발견자 | 경과 |
|------|--------|----|------|--------|------|
| 🔴 | 🔴 | `BUG-016` | 픽코 자동 등록 실패 | ska | 1일 전 |
| 🔴 | 🔴 | `BUG-017` | 픽코 자동 등록 실패 | ska | 0분 전 |

**최근 해결:**
- ✅ `BUG-006` **BOOT 재시작 시 파일명 텔레그램 출력 이슈**
  버그 최초 보고 (45일 전)
- ✅ `BUG-012` **pickko-member.js 회원 등록 중 Runtime.callFunctionOn 타임아웃 발생**
  010-9075-3796 유선욱 고객 회원 등록 중 Runtime.callFunctionOn timed out 오류 발생. Puppeteer protocolTimeout이 부족하거나 다른 원인으로 인해 회원 등록 프로세스가 완료되지 못함. (45일 전)
- ✅ `DXT-552824` **[덱스터] DB 무결성 오류**
  DuckDB (루나): Command failed: node "/var/folders/5r/5024qfb56hx2lkvw6jc_ldbm0000gn/T/dexter-db-1772410550619.js"
{"error":"Connection Error: Connection was never established or has been closed already"} (45일 전)
<!-- bug-tracker:issues:end -->

---

## 🔧 최근 유지보수 이력

> 자동 관리: `bug-report.js --maintenance` 실행 시 갱신

<!-- session-close:2026-02-27:findPickkoMember-공통-라이브러리화 -->
#### 2026-02-27 ♻️ findPickkoMember — 회원 조회 lib/pickko.js 공통 함수화
- `lib/pickko.js` `findPickkoMember(page, phone, delay)` 신규: study/write.html 모달 회원 조회 공통 함수
  - 검색 입력 → `#mb_select_btn` 클릭 → `li[mb_no]` 추출 → `{ found, mbNo, name }` 반환
  - id 방식 실패 시 "회원 선택" 텍스트 폴백, `a.detail_btn` href 폴백 내장
- `pickko-ticket.js`: `findMbNo()` 삭제 → `findPickkoMember` 교체
- `pickko-member.js`: `findMember()` 80줄 → 6줄 (`findPickkoMember` 위임)
- `pickko-accurate.js`: `syncMemberNameIfNeeded()` 내 인라인 35줄 → 1줄 교체
- 관련 파일: `lib/pickko.js`, `src/pickko-ticket.js`, `src/pickko-member.js`, `src/pickko-accurate.js`
<!-- session-close:2026-02-27:findPickkoMember-공통-라이브러리화:end -->

<!-- session-close:2026-02-27:pickko-ticket-할인-추가-기능 -->
#### 2026-02-27 ✨ pickko-ticket.js — 할인 추가 기능 (--discount)
- `--discount` 플래그: 이용권 전액 할인 (0원 처리) — 리뷰체험단, 이벤트 할인 등
- `--reason="사유"` 플래그: 주문 메모 + 할인 사유 입력 (기본값: "기타 할인")
- `applyDiscount()`: `#add_dc` → `#add_item_dsc`/`#add_item_price` → `#add_item_ok`
- `fillOrderMemo()`: `#od_memo` 텍스트 입력
- `handlePaymentPopups()`: 유료(`.pay_start` 클릭) / 0원(`.receipt_btn` 감지) 분기처리
- `waitForPayOrderEnabled()` 폴링: + 클릭 후 최대 8초 대기로 결제 흐름 안정화
- 관련 파일: `src/pickko-ticket.js`
<!-- session-close:2026-02-27:pickko-ticket-할인-추가-기능:end -->

<!-- session-close:2026-02-26:pickko-ticket-이용권-추가-cli -->
#### 2026-02-26 ✨ pickko-ticket.js — 픽코 이용권 추가 CLI
- `src/pickko-ticket.js` 신규: 전화번호 기반 이용권 추가 9단계 자동화
- 기간권 중복 방지 (count=1 강제), 시간권은 시스템 자동 중복 삭제
- `CLAUDE_NOTES.md` 이용권 추가 NLP 매핑 테이블 추가
- 관련 파일: `src/pickko-ticket.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-26:pickko-ticket-이용권-추가-cli:end -->

<!-- session-close:2026-02-26:sessionclose-라이브러리-구축 -->
#### 2026-02-26 ✨ session-close 라이브러리 구축
- scripts/lib 모듈화
- session-close CLI 신규
- deploy-context thin wrapper
- 관련 파일: `scripts/lib/`, `scripts/session-close.js`
<!-- session-close:2026-02-26:sessionclose-라이브러리-구축:end -->

<!-- session-close:2026-02-26:매출-통계-자연어-명령-추가-pickkostatscmd -->
#### 2026-02-26 ✨ 매출 통계 자연어 명령 추가 (pickko-stats-cmd.js)
- pickko-stats-cmd.js 신규: 날짜/주/월/누적 매출 조회
- lib/db.js getDailySummariesInRange 추가
- CLAUDE_NOTES.md 매출 통계 자연어 지침 추가
- 관련 파일: `src/pickko-stats-cmd.js`, `lib/db.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-26:매출-통계-자연어-명령-추가-pickkostatscmd:end -->

<!-- session-close:2026-02-26:자연어-명령-e2e-테스트-통합-매핑-추가 -->
#### 2026-02-26 ✨ 자연어 명령 E2E 테스트 + 통합 매핑 추가
- test-nlp-e2e.js 신규: 27케이스 100% 통과
- CLAUDE_NOTES.md 자연어 명령 전체 매핑 테이블 통합
- 관련 파일: `src/test-nlp-e2e.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-26:자연어-명령-e2e-테스트-통합-매핑-추가:end -->

<!-- session-close:2026-02-26:텔레그램-알람-불가-처리-pending-queue -->
#### 2026-02-26 텔레그램 알람 불가 처리 — pending queue 구현
- `lib/telegram.js` `pending-telegrams.jsonl` 대기큐: 3회 재시도 최종 실패 시 자동 저장
- `flushPendingTelegrams()` 신규: 재시작 시 대기큐 재발송, 성공 항목 제거
- `naver-monitor.js` 시작 시 `await flushPendingTelegrams()` 호출 추가
- 관련 파일: `lib/telegram.js`, `src/naver-monitor.js`
<!-- session-close:2026-02-26:텔레그램-알람-불가-처리-pending-queue:end -->

<!-- session-close:2026-02-27:전체-시스템-공유-인프라-구축 -->
#### 2026-02-27 ♻️ 전체 시스템 공유 인프라 구축
- packages/core 공유 유틸리티 채우기
- packages/playwright-utils 브라우저 헬퍼
- bots/_template 스캐폴딩
- reservation lib/cli.js 추가 및 6개 파일 중복 제거
- 관련 파일: `packages/core/`, `packages/playwright-utils/`, `bots/_template/`, `bots/reservation/lib/cli.js`
<!-- session-close:2026-02-27:전체-시스템-공유-인프라-구축:end -->

<!-- session-close:2026-02-27:완전-백그라운드-모드-전환-launchd-pickko- -->
#### 2026-02-27 ✨ 완전 백그라운드 모드 전환 (launchd + Pickko headless)
- lib/browser.js PICKKO_HEADLESS 환경변수 지원
- start-ops.sh PICKKO_HEADLESS=1 추가
- ai.ska.naver-monitor.plist launchd 상시 실행 등록
- 관련 파일: `bots/reservation/lib/browser.js`, `bots/reservation/src/start-ops.sh`, `ai.ska.naver-monitor.plist`
<!-- session-close:2026-02-27:완전-백그라운드-모드-전환-launchd-pickko-:end -->

<!-- session-close:2026-03-20:playwright-headless-기본화 -->
#### 2026-03-20 ♻️ 스카 브라우저 자동화 headless 기본화 + headed 디버그 토글
- `lib/browser.js` 공용 headless helper 추가
  - `PLAYWRIGHT_HEADLESS` 기본 토글
  - `NAVER_HEADLESS`, `PICKKO_HEADLESS` 하위 호환 유지
  - `.playwright-headed` 파일 기반 headed 전환 지원
- `naver-monitor.js`
  - 기본 실행을 `headless: 'new'`로 전환
  - 기존 `userDataDir` 기반 네이버 세션 유지
  - 로그인 폼 감지/종료 안내를 `PLAYWRIGHT_HEADLESS=false` 기준으로 갱신
- 진단 스크립트(`check-naver`, `inspect-naver`, `get-naver-html`, `analyze-booking-page`, `init-naver-booking-session`)도 동일 토글 구조로 정리
- 운영 루프/launchd
  - `start-ops.sh`, `ai.ska.naver-monitor.plist`에 `PLAYWRIGHT_HEADLESS=true` 기본값 반영
- 관련 파일: `lib/browser.js`, `auto/monitors/naver-monitor.js`, `src/check-naver.js`, `src/init-naver-booking-session.js`, `src/inspect-naver.js`, `src/analyze-booking-page.js`, `src/get-naver-html.js`, `auto/monitors/start-ops.sh`, `launchd/ai.ska.naver-monitor.plist`, `packages/playwright-utils/src/browser.js`

운영 가이드:
- 기본 운영은 headless
  - 별도 설정이 없으면 `PLAYWRIGHT_HEADLESS=true`로 해석
- 브라우저를 직접 보며 점검해야 할 때
  1. `touch bots/reservation/.playwright-headed`
  2. `bash bots/reservation/scripts/reload-monitor.sh`
  3. 네이버/픽코 확인 또는 수동 로그인
  4. 점검 종료 후 `rm bots/reservation/.playwright-headed`
  5. 다시 `bash bots/reservation/scripts/reload-monitor.sh`
- 빠른 1회 디버깅은 환경변수도 가능
  - `PLAYWRIGHT_HEADLESS=false node bots/reservation/src/init-naver-booking-session.js`
  - `PLAYWRIGHT_HEADLESS=false node bots/reservation/src/check-naver.js`
- 세션 만료 알림이 오면 위 headed 전환 절차를 우선 사용한다.
<!-- session-close:2026-03-20:playwright-headless-기본화:end -->

<!-- session-close:2026-02-27:시스템-설계-v20-ipad-원격-접속-투자봇-설계 -->
#### 2026-02-27 ✨ 시스템 설계 v2.0 + iPad 원격 접속 + 투자봇 설계
- SYSTEM_DESIGN.md v2.0 전면 개정 (봇별 LLM 확정·투자팀 3봇·메모리 할당)
- README.md 10봇 전체 아키텍처 다이어그램
- iPad Termius SSH 설정 (로컬+Tailscale 외부 접속)
- ~/.zshrc alias 등록 (ska/skalog/skastatus)
- OpenClaw 공식 문서 전체 학습
- 투자팀 멀티에이전트 설계 (투자메인봇+바이낸스실행봇+리서치봇+백테스팅)
- 2026 LLM·트레이딩봇 커뮤니티 리서치 (RESEARCH_2026.md 저장)
- 공유 인프라 packages/core + playwright-utils 구축
- PICKKO_HEADLESS=1 launchd KeepAlive 백그라운드 전환
- 관련 파일: `docs/SYSTEM_DESIGN.md`, `docs/RESEARCH_2026.md`, `README.md`, `~/.zshrc`, `~/.ssh/authorized_keys`
<!-- session-close:2026-02-27:시스템-설계-v20-ipad-원격-접속-투자봇-설계:end -->

<!-- session-close:2026-02-27:bug007-수정-boot-파일명-누출-방지 -->
#### 2026-02-27 🔧 BUG-007 수정 + BOOT 파일명 누출 방지
- BUG-007: protocolTimeout 30초 + Promise.race 8초 타임아웃
- CLAUDE_NOTES: BOOT 중 파일명 단독 전송 금지 규칙 추가
- BUG-006 재발 모니터링 중
- 관련 파일: `src/naver-monitor.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-27:bug007-수정-boot-파일명-누출-방지:end -->

<!-- session-close:2026-02-27:libargsjs-불리언-플래그-지원-bugreport -->
#### 2026-02-27 ♻️ lib/args.js 불리언 플래그 지원 + bug-report.js parseArgs 통합
- lib/args.js: --key 불리언 플래그 지원 (next가 --로 시작하면 true)
- bug-report.js: 인라인 parseArgs 제거 → require('../lib/args') 통합
- 관련 파일: `bots/reservation/lib/args.js`, `bots/reservation/src/bug-report.js`
<!-- session-close:2026-02-27:libargsjs-불리언-플래그-지원-bugreport:end -->

<!-- session-close:2026-02-27:boot-속도-최적화-7분50초 -->
#### 2026-02-27 ♻️ BOOT 속도 최적화 — 7분→50초
- deployer.js generateOpenclawBoot: IDENTITY+MEMORY 인라인, --sync 제거, DEV_SUMMARY/HANDOFF BOOT 제외
- BOOT 7턴→2턴 (50초, 8.4× 개선)
- 관련 파일: `scripts/lib/deployer.js`
<!-- session-close:2026-02-27:boot-속도-최적화-7분50초:end -->

<!-- session-close:2026-02-27:boot-시간-재확인-54초-2회-연속-검증 -->
#### 2026-02-27 ⚙️ BOOT 시간 재확인 — 54초 2회 연속 검증
- BOOT durationMs=54121 확인 (gemini-2.5-flash, 2회 연속)
- 로그 파일 경로 확인: /tmp/openclaw/openclaw-YYYY-MM-DD.log
- 모니터링 명령 개선: gateway.err.log → /tmp/openclaw/ 파일 참조
- 관련 파일: `scripts/lib/deployer.js`
<!-- session-close:2026-02-27:boot-시간-재확인-54초-2회-연속-검증:end -->

<!-- session-close:2026-02-27:코딩가이드-목적-재정의-workhistorycoding -->
#### 2026-02-27 ♻️ 코딩가이드 목적 재정의 + work-history/coding-guide 세션마감 자동화
- coding-guide.md: 핵심 원칙 섹션 추가, 목적 재정의
- doc-patcher.js: patchWorkHistory + patchCodingGuide 추가
- session-close.js: docsDir 연결
- 관련 파일: `docs/coding-guide.md`, `scripts/lib/doc-patcher.js`, `scripts/session-close.js`
<!-- session-close:2026-02-27:코딩가이드-목적-재정의-workhistorycoding:end -->

<!-- session-close:2026-02-27:코딩가이드-security-by-design-전면-적용 -->
#### 2026-02-27 ♻️ 코딩가이드 Security by Design 전면 적용
- Security by Design 원칙 선언 (어기면 코드가 실행 안 되는 구조)
- lib/secrets.js 강제 검증 패턴 (필수 키 누락 시 즉시 종료)
- pre-commit hook 차단 패턴 (secrets.json git 커밋 자동 차단)
- SafeExchange 클래스 레벨 DEV/OPS 분리 (우회 불가)
- 전체 봇 로그 마스킹·입력 검증·감사 로그 패턴 추가
- 관련 파일: `docs/coding-guide.md`
<!-- session-close:2026-02-27:코딩가이드-security-by-design-전면-적용:end -->

<!-- session-close:2026-02-27:precommit-훅-설치-및-공유-인프라-플랜-완료- -->
#### 2026-02-27 ⚙️ pre-commit 훅 설치 및 공유 인프라 플랜 완료 검증
- scripts/pre-commit 설치 (.git/hooks/ 등록 + chmod +x)
- scripts/setup-hooks.sh 원클릭 설치 스크립트 신규
- packages/core·playwright-utils·_template 플랜 완료 검증 (전 Phase 완료 확인)
- 관련 파일: `scripts/pre-commit`, `scripts/setup-hooks.sh`
<!-- session-close:2026-02-27:precommit-훅-설치-및-공유-인프라-플랜-완료-:end -->

<!-- session-close:2026-02-27:st001003-완료-ska-설계-백로그-전체-등록 -->
#### 2026-02-27 ✨ ST-001~003 완료 + ska 설계 + 백로그 전체 등록
- ST-001 state.db 자동 백업 (launchd 03:00 일일)
- ST-002 BUG-006 해결 — deployer.js BOOT 침묵 강화 + telegram.js 파일명 필터
- ST-003 launchd 헬스체크 (10분 주기, 7개 서비스 감시)
- ska 매출예측 시스템 설계 확정 (Prophet + DuckDB, 4개 봇팀)
- 전체 개발 백로그 등록 (ST/FE/MD/LT 20개 항목)
- 관련 파일: `bots/reservation/scripts/backup-db.js|bots/reservation/scripts/health-check.js|bots/reservation/lib/telegram.js|scripts/lib/deployer.js|Library/LaunchAgents/ai.ska.db-backup.plist|Library/LaunchAgents/ai.ska.health-check.plist`
<!-- session-close:2026-02-27:st001003-완료-ska-설계-백로그-전체-등록:end -->

<!-- session-close:2026-02-27:fe002-룸별시간대별-가동률-리포트-구현 -->
#### 2026-02-27 ✨ FE-002 룸별·시간대별 가동률 리포트 구현
- src/occupancy-report.js 신규: 룸별/시간대별 가동률 계산
- 영업시간 09:00~22:00 기준 13슬롯 분석
- --period=week/month --month=YYYY-MM 기간 옵션 지원
- CLAUDE_NOTES.md 가동률 자연어 명령 테이블 추가
- 관련 파일: `src/occupancy-report.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-27:fe002-룸별시간대별-가동률-리포트-구현:end -->

<!-- session-close:2026-02-27:fe005-로그-rotation-copytruncate -->
#### 2026-02-27 ✨ FE-005 로그 rotation (copytruncate, 매일 04:05)
- scripts/log-rotate.js 신규: 10개 로그 copytruncate 방식 로테이션
- ai.ska.log-rotate.plist: 매일 04:05 자동 실행
- 보관 7일, 1KB 미만 스킵, 당일 중복 방지
- health-check.js: 8번째 서비스(log-rotate) 추가
- 관련 파일: `scripts/log-rotate.js`, `~/Library/LaunchAgents/ai.ska.log-rotate.plist`, `scripts/health-check.js`
<!-- session-close:2026-02-27:fe005-로그-rotation-copytruncate:end -->

<!-- session-close:2026-02-27:fe006-gemini25flash-execute_to -->
#### 2026-02-27 ⚙️ FE-006 gemini-2.5-flash execute_tool 누출 버그 재테스트 — 버그 종결
- gemini-2.5-flash telegram run 6건 전수 검사 — execute_tool 텍스트 누출 0건
- 실제 도구 호출(tool=exec) 정상 확인 — 버그 미재현으로 종결
- 부수 발견: sendChatAction 실패 10건 (typing 인디케이터, 메시지 발송 무영향)
<!-- session-close:2026-02-27:fe006-gemini25flash-execute_to:end -->

<!-- session-close:2026-02-27:fe009-healthcheck-staleness-체크 -->
#### 2026-02-27 ✨ FE-009 health-check staleness 체크 추가 (naver-monitor 크래시루프 감지)
- health-check.js: checkNaverLogStaleness() 추가 — 15분 무활동 시 알림
- PID 체크만으로 감지 못했던 크래시루프 상황 커버
- 30분 쿨다운 적용, 로그 없으면 스킵
- 관련 파일: `scripts/health-check.js`
<!-- session-close:2026-02-27:fe009-healthcheck-staleness-체크:end -->

<!-- session-close:2026-02-27:fe007-mosh-설치-및-아이패드-ssh-환경-개선 -->
#### 2026-02-27 ⚙️ FE-007 mosh 설치 및 아이패드 SSH 환경 개선 검토
- mosh 1.4.0 설치 완료 (brew install mosh)
- ~/.zprofile 생성 — SSH 로그인 셸 PATH 설정 (mosh-server 검색 가능)
- 검토 결과: 한글 입력 개선 없음(transport 무관 Ink 버그)
- 실제 이점: WiFi↔LTE 전환 시 세션 유지, 네트워크 복구
- 관련 파일: `~/.zprofile`
<!-- session-close:2026-02-27:fe007-mosh-설치-및-아이패드-ssh-환경-개선:end -->

<!-- session-close:2026-02-27:fe008-claude-code-한글-버그-github -->
#### 2026-02-27 ⚙️ FE-008 Claude Code 한글 버그 GitHub 이슈 #15705 코멘트 등록
- 기존 이슈 #15705 확인 (OPEN, 9개 코멘트, area:tui bug 레이블)
- 코멘트 추가: macOS 로컬(iTerm2) 재현 + rlwrap/mosh 무효 확인
- 단기 FE 백로그 전체 완료 (FE-002~009)
<!-- session-close:2026-02-27:fe008-claude-code-한글-버그-github:end -->

<!-- session-close:2026-02-27:md006-datagokr-api-키-발급-가이드 -->
#### 2026-02-27 ⚙️ MD-006: data.go.kr API 키 발급 가이드
- secrets.json 플레이스홀더 4개 추가
- improvement-ideas.md MD-006 완료 처리
- API 신청 가이드 작성
- 관련 파일: `bots/reservation/secrets.json`
<!-- session-close:2026-02-27:md006-datagokr-api-키-발급-가이드:end -->

<!-- session-close:2026-02-27:픽코-타임아웃-근본-해결-자동-버그리포트-ska001- -->
#### 2026-02-27 🔧 픽코 타임아웃 근본 해결 + 자동 버그리포트 + ska-001 + SKA 통일
- pickko-accurate.js 7단계 page.click→evaluate (Runtime.callFunctionOn 타임아웃 근본 해결)
- pickko-cancel.js 3단계 page.$eval/click→evaluate 동일 수정
- naver-monitor.js autoBugReport() 추가 — 픽코 오류 시 bug-tracker 자동 등록
- ska-001 DuckDB 스키마 생성 (revenue_daily·environment_factors·forecast)
- bots/scar→bots/ska 디렉토리 + 전체 문서 SKA 통일
- MD-006 data.go.kr API 키 4종 secrets.json 등록 완료
- 관련 파일: `bots/reservation/src/pickko-accurate.js`, `bots/reservation/src/pickko-cancel.js`, `bots/reservation/src/naver-monitor.js`, `bots/ska/scripts/setup-db.py`
<!-- session-close:2026-02-27:픽코-타임아웃-근본-해결-자동-버그리포트-ska001-:end -->

<!-- session-close:2026-02-27:ska005008-완료-이브크롤링launchd-스케줄링 -->
#### 2026-02-27 ✨ ska-005~008 완료 — 이브크롤링+launchd 스케줄링
- ska-005 이브크롤링(큐넷+수능) — 547건 upsert 343일
- ska-008 launchd 4개 서비스 완료 — etl/eve/eve-crawl/rebecca
- scripts/send-telegram.py + scripts/run-rebecca.sh 생성
- ai.ska.etl(00:30)+ai.ska.eve(06:00)+ai.ska.eve-crawl(일04:30)+ai.ska.rebecca(08:00)
- 관련 파일: `bots/ska/src/eve_crawl.py|bots/ska/scripts/send-telegram.py|bots/ska/scripts/run-rebecca.sh`
<!-- session-close:2026-02-27:ska005008-완료-이브크롤링launchd-스케줄링:end -->

<!-- session-close:2026-02-27:ska006-완료-prophet-매출-예측-엔진 -->
#### 2026-02-27 ✨ ska-006 완료 — Prophet 매출 예측 엔진
- forecast.py Prophet 기본 엔진 (daily/weekly/monthly 3모드)
- regressor: exam_score+rain_prob+vacation_flag+KR 공휴일
- base_forecast=요일히스토리평균 / yhat=Prophet예측 / 신뢰구간 80%
- ai.ska.forecast-daily(매일18:00)+ai.ska.forecast-weekly(금18:00) launchd
- scripts/run-forecast.sh + requirements.txt prophet==1.3.0 추가
- 관련 파일: `bots/ska/src/forecast.py|bots/ska/scripts/run-forecast.sh|bots/ska/requirements.txt`
<!-- session-close:2026-02-27:ska006-완료-prophet-매출-예측-엔진:end -->

<!-- session-close:2026-02-27:ska007-완료-prophet-regressor-ex -->
#### 2026-02-27 ✨ ska-007 완료 — Prophet regressor exam_events 연동
- forecast.py prophet-v1→v2 업그레이드
- load_history: exam_events JOIN으로 역사데이터 exam_score 강화
- load_future_env: UNION approach로 env+exam_events 완전 커버
- 3월 학력평가 score=5 자동 반영 확인 (3/12 당일, 3/7~11 D-7 prep)
- 관련 파일: `bots/ska/src/forecast.py`
<!-- session-close:2026-02-27:ska007-완료-prophet-regressor-ex:end -->

<!-- session-close:2026-02-27:ska014015-대학교-크롤링-공무원-정적-캘린더 -->
#### 2026-02-27 ✨ ska-014/015: 대학교 크롤링 + 공무원 정적 캘린더
- ska-014: 가천대·단국대 죽전 시험기간 Playwright 크롤링
- ska-015: 공무원 시험 정적 캘린더 (국가직9급·지방직9급·7급·경찰·소방)
- upsert_events source 파라미터 추가 (calc/crawl/static 구분)
- exam_events: 850행 (calc547+crawl148+static155)
- 4월 중간고사 exam_score 피크 12~15 정상
- 관련 파일: `bots/ska/src/eve_crawl.py`
<!-- session-close:2026-02-27:ska014015-대학교-크롤링-공무원-정적-캘린더:end -->

<!-- session-close:2026-02-27:설계문서-v21-레베카-llm-제거-확정 -->
#### 2026-02-27 ⚙️ 설계문서 v2.1: 레베카 LLM 제거 확정
- ska-design.md v2.1 업데이트
- 레베카 LLM 완전 제거 (팀 테이블·LLM 레이어·리포트 종류·피드백 루프)
- LLM은 포캐스트 월간 전담으로 확정
- launchd 스케줄 전체 17개 plist 현황 반영
- Phase 1·2 완료 표기
- 관련 파일: `memory/ska-design.md`
<!-- session-close:2026-02-27:설계문서-v21-레베카-llm-제거-확정:end -->

<!-- session-close:2026-02-27:설계문서-v22-phase-33-루프-자동화-로드맵 -->
#### 2026-02-27 ⚙️ 설계문서 v2.2: Phase 3/3+ 루프 자동화 로드맵
- Phase 3 목표 명확화 (진단→수동 적용, 반자동, 3개월+)
- Phase 3+ 신설 (완전 자동 루프, 6개월+, 백테스트+롤백)
- 루프 구조 요약 섹션 추가 (Phase별 자동화 수준)
- ska-design.md v2.2 업데이트
- 관련 파일: `memory/ska-design.md`
<!-- session-close:2026-02-27:설계문서-v22-phase-33-루프-자동화-로드맵:end -->

<!-- session-close:2026-02-27:tmux-remote-control-설정-llm-api -->
#### 2026-02-27 ⚙️ tmux Remote Control 설정 + LLM API 코드 개선
- tmux 설치 + ai.ska.tmux launchd 등록 (재부팅 자동 복구)
- 아이패드 Claude Remote Control (/rc) 연결 확인
- forecast.py _call_llm_diagnosis system 파라미터 분리 + Prompt Caching + temperature=0.1 + 에러 세분화
- coding-guide.md 섹션 12/13 Anthropic SDK 직접 호출 패턴 + temperature 가이드 + 모델 표 추가
- 관련 파일: `bots/ska/src/forecast.py|docs/coding-guide.md|Library/LaunchAgents/ai.ska.tmux.plist|start-ska-session.sh`
<!-- session-close:2026-02-27:tmux-remote-control-설정-llm-api:end -->

<!-- session-close:2026-02-27:cl006-코딩가이드-기준-전체-코드-리팩토링 -->
#### 2026-02-27 ♻️ CL-006 코딩가이드 기준 전체 코드 리팩토링
- maskPhone/maskName 함수 추가 (lib/formatting.js)
- JS 8개 파일 개인정보 로그 마스킹 (phone/name)
- Python DB 연결 try/finally 래핑 (etl/rebecca/eve)
- Python 에러 묵음→경고 출력 (etl/eve/eve_crawl)
- writeFileSync→saveJson 전환 (naver-monitor/bug-report)
- inspect-naver.js 하드코딩 경로 제거
- 관련 파일: `lib/formatting.js`, `src/naver-monitor.js`, `src/pickko-accurate.js`, `src/pickko-verify.js`, `src/pickko-member.js`, `src/pickko-ticket.js`, `src/pickko-kiosk-monitor.js`, `src/pickko-daily-audit.js`, `src/pickko-daily-summary.js`, `src/bug-report.js`, `src/inspect-naver.js`, `bots/ska/src/etl.py`, `bots/ska/src/rebecca.py`, `bots/ska/src/eve.py`, `bots/ska/src/eve_crawl.py`
<!-- session-close:2026-02-27:cl006-코딩가이드-기준-전체-코드-리팩토링:end -->

<!-- session-close:2026-02-27:pickkodailyauditsummary-실행-시간- -->
#### 2026-02-27 ⚙️ pickko-daily-audit/summary 실행 시간 23:50으로 변경
- pickko-daily-audit 22:00→23:50 (plist 수정 + launchd 재등록)
- pickko-daily-summary 00:00→23:50 (LaunchAgents plist 수정 + launchd 재등록)
- 관련 파일: `bots/reservation/ai.ska.pickko-daily-audit.plist`, `LaunchAgents/ai.ska.pickko-daily-summary.plist`
<!-- session-close:2026-02-27:pickkodailyauditsummary-실행-시간-:end -->

<!-- session-close:2026-02-28:pickkodailyaudit-스케줄-2200-원복 -->
#### 2026-02-28 ⚙️ pickko-daily-audit 스케줄 22:00 원복
- pickko-daily-audit 23:50→22:00 원복 (plist 수정 + launchd 재등록)
- 관련 파일: `bots/reservation/ai.ska.pickko-daily-audit.plist`
<!-- session-close:2026-02-28:pickkodailyaudit-스케줄-2200-원복:end -->

<!-- session-close:2026-02-28:openclaw-v2026226-업데이트-및-재시작 -->
#### 2026-02-28 ⚙️ OpenClaw v2026.2.26 업데이트 및 재시작
- openclaw gateway restart (완전 중지 후 재시작)
- openclaw v2026.2.19-2 → v2026.2.26 업데이트
- 텔레그램 업데이트 완료 알림 전송
<!-- session-close:2026-02-28:openclaw-v2026226-업데이트-및-재시작:end -->

<!-- session-close:2026-02-28:스카-재부팅 -->
#### 2026-02-28 ⚙️ 스카 재부팅
- openclaw gateway restart → 스카 부팅 완료 (durationMs=59s)
<!-- session-close:2026-02-28:스카-재부팅:end -->

<!-- session-close:2026-02-28:매출-보고-일반이용-합산-수정 -->
#### 2026-02-28 🔧 매출 보고 일반이용 합산 수정
- pickko-daily-summary.js: 23:50 자동 보고 합계에 일반이용(스터디카페) 포함
- pickko-stats-cmd.js: 일별/기간별 조회 합계에 일반이용 포함
- pickko-revenue-confirm.js: 매출 확정 메시지 합계에 일반이용 포함
- CLAUDE_NOTES.md: 매출 보고 시 일반이용 포함 규칙 추가
- 관련 파일: `bots/reservation/src/pickko-daily-summary.js|bots/reservation/src/pickko-stats-cmd.js|bots/reservation/src/pickko-revenue-confirm.js|bots/reservation/context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-28:매출-보고-일반이용-합산-수정:end -->

<!-- session-close:2026-02-28:미해결-알림-해제-매출-일반이용-합산-수정 -->
#### 2026-02-28 🔧 미해결 알림 해제 + 매출 일반이용 합산 수정
- 픽코 취소 실패 알림 수동 resolved 처리 (2026-02-27 18:00 A2)
- naver-monitor 재시작 후 미해결 알림 반복 전송 중단 확인
- pickko-daily-summary.js 일반이용 합계 포함 수정
- pickko-stats-cmd.js 일반이용 합계 포함 수정
- pickko-revenue-confirm.js 일반이용 합계 포함 수정
- CLAUDE_NOTES.md 매출 보고 규칙 추가
- 관련 파일: `bots/reservation/src/pickko-daily-summary.js|bots/reservation/src/pickko-stats-cmd.js|bots/reservation/src/pickko-revenue-confirm.js|bots/reservation/context/CLAUDE_NOTES.md`
<!-- session-close:2026-02-28:미해결-알림-해제-매출-일반이용-합산-수정:end -->

<!-- session-close:2026-02-28:고아-프로세스-자동-정리-추가 -->
#### 2026-02-28 🔧 고아 프로세스 자동 정리 추가
- start-ops.sh cleanup_old()에 고아 tail -f 프로세스 자동 정리 추가 (2시간 재시작마다 실행)
- 관련 파일: `bots/reservation/src/start-ops.sh`
<!-- session-close:2026-02-28:고아-프로세스-자동-정리-추가:end -->

<!-- session-close:2026-02-28:runtimecallfunctionon-타임아웃-근본- -->
#### 2026-02-28 🔧 Runtime.callFunctionOn 타임아웃 근본 수정 + DB 중복 레코드 정리
- pickko-accurate.js page.click→evaluate (회원선택 버튼)
- pickko-verify.js page.click→evaluate (검색 버튼)
- start-ops.sh PICKKO_PROTOCOL_TIMEOUT_MS=300000 추가
- DB 중복 레코드 정리 (010-2187-5073 03-14 failed)
- 관련 파일: `src/pickko-accurate.js`, `src/pickko-verify.js`, `src/start-ops.sh`
<!-- session-close:2026-02-28:runtimecallfunctionon-타임아웃-근본-:end -->

<!-- session-close:2026-02-28:2350-generalrevenue-미수집-중복예약-표 -->
#### 2026-02-28 🔧 23:50 generalRevenue 미수집 + 중복예약 표시 버그 수정
- isMidnight 버그 수정 (hourKST===0 → hourKST===23
- 0) — 23:50 실행시 generalRevenue 수집
- dedup 키 수정 (date
- start
- end
- room → date
- start
- room) — 중복예약 11건→8건 정리
- launchd runs=0 원인 규명 — 재부팅 카운터 리셋, 오딧 정상 운영 확인
- etl.py sqlite_con.close() finally 블록 이동
- 관련 파일: `bots/reservation/src/pickko-daily-summary.js|bots/ska/src/etl.py`
<!-- session-close:2026-02-28:2350-generalrevenue-미수집-중복예약-표:end -->

<!-- session-close:2026-02-28:cl006-코딩가이드-리팩토링-완료-확인-백필-스크립트 -->
#### 2026-02-28 🔧 CL-006 코딩가이드 리팩토링 완료 확인 + 백필 스크립트
- CL-006 플랜 전항목 완료 확인 (P0~P4 모두 이전 세션에서 구현됨)
- backfill-study-room.js 36건 업데이트 완료 (이전 세션 작업)
- pickko-daily-summary isMidnight 23:50 버그 수정 확인
- 관련 파일: `bots/reservation/src/backfill-study-room.js|bots/reservation/src/pickko-daily-summary.js`
<!-- session-close:2026-02-28:cl006-코딩가이드-리팩토링-완료-확인-백필-스크립트:end -->

<!-- session-close:2026-03-01:새로고침-버튼-fix-알림-컨텍스트-공유 -->
#### 2026-03-01 🔧 새로고침 버튼 fix + 알림 컨텍스트 공유
- naver-monitor 새로고침 버튼 ElementHandle.click→evaluate() 수정
- pickko-alerts-query.js 신규 (알림 DB 조회 CLI)
- CLAUDE_NOTES.md 알림 인식 규칙 추가 (방금 알림 키워드 트리거)
- deployer.js BOOT.md 생성 시 최근 48시간 에러 알림 자동 인라인
- 관련 파일: `bots/reservation/src/naver-monitor.js|bots/reservation/src/pickko-alerts-query.js|bots/reservation/context/CLAUDE_NOTES.md|scripts/lib/deployer.js`
<!-- session-close:2026-03-01:새로고침-버튼-fix-알림-컨텍스트-공유:end -->

<!-- session-close:2026-03-01:etl-actual_revenue-입금-기준-전환-pi -->
#### 2026-03-01 🔧 ETL actual_revenue 입금 기준 전환 + pickko_total 분석
- ETL actual_revenue: pickko_total(이용일) → total_amount(입금일) 기준 전환
- studyroom_revenue = total_amount - general_revenue 로 재계산
- DuckDB 02/28 수동 수정 (236,000→319,500)
- ETL 즉시 재실행 — 91건 upsert, 02/27·02/28 정상화
- 관련 파일: `bots/ska/src/etl.py`
<!-- session-close:2026-03-01:etl-actual_revenue-입금-기준-전환-pi:end -->

<!-- session-close:2026-03-01:boot-침묵-규칙-통일-etl-total_amount -->
#### 2026-03-01 🔧 BOOT 침묵 규칙 통일 + ETL total_amount 기준 변경
- BOOT.md 메시지 전송 규칙 제거(침묵 대기로 통일)
- ETL actual_revenue를 total_amount 기준으로 변경
- DuckDB 02/28 actual_revenue 수동 수정(319,500)
- naver-monitor 새로고침 버튼 click 타임아웃 수정
- pickko-alerts-query.js 신규 생성
- deployer.js BOOT 에러 알림 인라인 추가
- 관련 파일: `scripts/lib/deployer.js bots/ska/src/etl.py bots/reservation/src/naver-monitor.js bots/reservation/src/pickko-alerts-query.js bots/reservation/context/CLAUDE_NOTES.md`
<!-- session-close:2026-03-01:boot-침묵-규칙-통일-etl-total_amount:end -->

<!-- session-close:2026-03-01:미컨펌-알림-날짜-버그-수정 -->
#### 2026-03-01 🔧 미컨펌 알림 날짜 버그 수정
- 미컨펌 알림 범위 최근 3일 이내로 제한
- 메시지 '어제 매출이' → 실제 날짜(prevHeader) 표시로 수정
- 관련 파일: `bots/reservation/src/pickko-daily-summary.js`
<!-- session-close:2026-03-01:미컨펌-알림-날짜-버그-수정:end -->

<!-- session-close:2026-03-01:예약-오류-체크-픽코-cdp-타임아웃-원인-분석 -->
#### 2026-03-01 ⚙️ 예약 오류 체크 - 픽코 CDP 타임아웃 원인 분석
- 픽코 예약 실패 원인 확인 (Runtime.callFunctionOn timed out)
- 픽코 서버 일시 지연 → 재시도 로직 정상 작동 확인
- 3건 모두 최종 픽코 등록 성공 확인 (verified)
<!-- session-close:2026-03-01:예약-오류-체크-픽코-cdp-타임아웃-원인-분석:end -->

<!-- session-close:2026-03-01:스카-재시작-및-부팅-확인 -->
#### 2026-03-01 ⚙️ 스카 재시작 및 부팅 확인
- 스카 재시작 (PID 66467)
- 부팅 완료 확인 (5.2초, isError=false)
<!-- session-close:2026-03-01:스카-재시작-및-부팅-확인:end -->

<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용 -->
#### 2026-03-01 ✨ 스카팀 루나팀 패턴 적용 ①②③
- DB Migration System (scripts/migrate.js + migrations/)
- Secrets Fallback Strategy (lib/secrets.js + lib/telegram.js)
- Start Script Validation (scripts/preflight.js + start-ops.sh 2중 체크)
- 관련 파일: `scripts/preflight.js|src/start-ops.sh|lib/secrets.js|lib/telegram.js|scripts/migrate.js|migrations/001_initial_schema.js|migrations/002_daily_summary_columns.js`
<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용:end -->

<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss -->
#### 2026-03-02 ✨ SKA-P05~P08 루나팀 패턴 적용 + deploy-ops.sh
- lib/error-tracker.js 연속 오류 카운터 (naver-monitor+kiosk-monitor 통합)
- scripts/e2e-test.js E2E 통합 테스트 28/28
- lib/mode.js DEV/OPS 모드 분리 (MODE=ops, getModeSuffix)
- lib/status.js 프로세스 상태 파일 /tmp/ska-status.json
- scripts/deploy-ops.sh E2E→컨펌→OPS재시작→체크섬→텔레그램
- 관련 파일: `bots/reservation/lib/error-tracker.js|bots/reservation/lib/mode.js|bots/reservation/lib/status.js|bots/reservation/scripts/e2e-test.js|bots/reservation/scripts/deploy-ops.sh|bots/reservation/src/naver-monitor.js`
<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss:end -->

<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss -->
#### 2026-03-02 ✨ 3중 가동/중지 lib/health.js + deploy-ops.sh
- lib/health.js 3중 가동(preflightSystemCheck/ConnCheck)+3중 중지(shutdownDB/Cleanup/registerShutdownHandlers)
- scripts/preflight.js health.js 래퍼로 교체
- src/start-ops.sh 3중 체크 추가(--conn)
- src/naver-monitor.js registerShutdownHandlers+isShuttingDown 루프 가드
- scripts/e2e-test.js 32/32 통과
- 관련 파일: `bots/reservation/lib/health.js|bots/reservation/scripts/preflight.js|bots/reservation/src/start-ops.sh|bots/reservation/src/naver-monitor.js|bots/reservation/scripts/e2e-test.js`
<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss:end -->

<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙 -->
#### 2026-03-02 ✨ 하트비트 오늘예약현황 추가 + scar→ska 정리 + 절대규칙 등록
- getTodayStats() DB함수 추가 (네이버+키오스크 합계)
- 하트비트 메시지 오늘 예약현황 섹션 추가
- etl.py scar.duckdb→ska.duckdb 주석 수정
- 이브(Eve) 절대규칙 스카팀 등록 + registry.json 추가
- 절대규칙 기본언어 한국어 추가
- 관련 파일: `bots/reservation/lib/db.js|bots/reservation/src/naver-monitor.js|bots/ska/src/etl.py|bots/registry.json`
<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙:end -->

<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가 -->
#### 2026-03-02 ✨ 대리등록-네이버-예약불가-자동처리-로직-추가
- pickko-kiosk-monitor.js blockSlotOnly() + --block-slot 모드 추가
- pickko-register.js 픽코 등록 성공 후 네이버 차단 자동 호출
- 오수정님 테스트 통과 (이미 차단됨 감지)
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js|bots/reservation/src/pickko-register.js`
<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가:end -->

<!-- session-close:2026-03-02:오늘예약검증audittoday구현 -->
#### 2026-03-02 ✨ 오늘-예약-검증-audit-today-구현
- auditToday() 함수 추가 (pickko-kiosk-monitor.js)
- getKioskBlocksForDate(date) DB 함수 추가 (lib/db.js)
- --audit-today 진입점 추가
- run-today-audit.sh 래퍼 스크립트 생성
- ai.ska.today-audit.plist 08:30 KST launchd 등록
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js`, `bots/reservation/lib/db.js`, `bots/reservation/src/run-today-audit.sh`
<!-- session-close:2026-03-02:오늘예약검증audittoday구현:end -->

<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가 -->
#### 2026-03-02 🔧 auditToday-failedList-차단실패-알림-추가
- blockNaverSlot false반환시 DB false positive 방지 확인
- auditToday failedList 추가 - 차단실패 텔레그램 알림
- 덱스터 체크섬 갱신
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js`
<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가:end -->

<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공 -->
#### 2026-03-02 🔧 blockNaverSlot-avail소멸-보조확인-차단성공
- verifyBlockInGrid suspended만 확인하는 한계 발견
- blockNaverSlot avail 소멸 보조 확인 추가 (예약가능설정 방식 차단 지원)
- B룸 18:00 차단 성공 확인
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js`
<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공:end -->

<!-- session-close:2026-03-02:auditdate내일날짜검증완료 -->
#### 2026-03-02 ✨ audit-date-내일날짜-검증-완료
- auditToday dateOverride 파라미터 추가
- --audit-date=YYYY-MM-DD CLI 옵션 추가
- 내일(03/03) 고아차단 해제 흐름 검증 완료
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js`
<!-- session-close:2026-03-02:auditdate내일날짜검증완료:end -->

<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot -->
#### 2026-03-02 ✨ 픽코취소-네이버해제-자동화-unblock-slot
- unblockNaverSlot avail-gone 버그 수정 (false positive return 제거)
- restoreAvailGoneSlot 헬퍼 추가 (B룸 예약가능설정방식 복구)
- unblockSlotOnly + --unblock-slot CLI 모드 추가
- pickko-cancel-cmd.js: 픽코취소→네이버해제 자동 2단계 실행
- 관련 파일: `bots/reservation/src/pickko-kiosk-monitor.js bots/reservation/src/pickko-cancel-cmd.js`
<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot:end -->

<!-- session-close:2026-03-02:취소테스트성공availgone복구확인 -->
#### 2026-03-02 🔧 취소-테스트-성공-avail-gone-복구-확인
- 이승호 B룸 18:00 취소 테스트 성공 (픽코취소+네이버해제)
- avail-gone 방식 복구 확인 (restoreAvailGoneSlot 정상 작동)
- 관련 파일: `bots/reservation/src/pickko-cancel-cmd.js bots/reservation/src/pickko-kiosk-monitor.js`
<!-- session-close:2026-03-02:취소테스트성공availgone복구확인:end -->

<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정 -->
#### 2026-03-02 ✨ 예약 취소 E2E 완성 + TOOLS.md 취소/등록 도구 정비
- pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제) 완성
- avail-gone 방식 unblockNaverSlot 수정 + restoreAvailGoneSlot 구현
- --block-slot --unblock-slot --audit-date CLI 추가
- TOOLS.md 취소 섹션 추가 + pickko-accurate.js 내부모듈 명시
- 취소+등록 E2E 스카봇 자연어 테스트 통과
- 관련 파일: `src/pickko-kiosk-monitor.js`, `src/pickko-cancel-cmd.js`, `context/CLAUDE_NOTES.md`
<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정:end -->

<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai -->
#### 2026-03-04 ♻️ 전체 봇 sendTelegram → alert publisher 계열 호출 전환 시작
- error-tracker.js 마지막 교체 완료
- dexter 체크섬 갱신 (9개 파일)
- 관련 파일: `bots/reservation/lib/error-tracker.js`
<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai:end -->

<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습 -->
#### 2026-03-04 ✨ LLM키통합+알람버그수정+덱스터패턴학습
- packages/core/lib/llm-keys.js 공용 LLM 키 로더
- mainbot_queue 무한반복 알람 버그 수정
- 덱스터 mainbot_queue 건강 체크 추가
- 덱스터 오류 패턴 학습 시스템 (dexter_error_log)
- 관련 파일: `packages/core/lib/llm-keys.js|bots/orchestrator/src/filter.js|bots/orchestrator/src/mainbot.js|bots/claude/lib/checks/database.js|bots/claude/lib/error-history.js|bots/claude/lib/checks/patterns.js|bots/claude/src/dexter.js`
<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습:end -->

<!-- session-close:2026-03-05:헬스체크-회복-로직-제이-할루시네이션-방지-dbback -->
#### 2026-03-05 🔧 헬스체크 회복 로직 + 제이 할루시네이션 방지 + db-backup 수정
- health-check.js 회복 감지·알림·state 저장 로직 추가
- backup-db.js async 누락 수정
- intent-parser.js 스카 점검 패턴 추가
- TOOLS.md 제이 bot_commands 명령 테이블 + 할루시네이션 방지 경고 추가
- 전체 흐름 테스트 완료 (회복 알림 텔레그램 수신 확인)
- 관련 파일: `bots/reservation/scripts/health-check.js|bots/reservation/scripts/backup-db.js|bots/orchestrator/lib/intent-parser.js`
<!-- session-close:2026-03-05:헬스체크-회복-로직-제이-할루시네이션-방지-dbback:end -->

<!-- session-close:2026-03-05:취소-루틴-버그-수정-블러키-충돌 -->
#### 2026-03-05 🔧 취소 루틴 버그 수정 (블러/키 충돌)
- page.click(body)→Escape 키 수정(상세보기 블러 문제)
- toCancelKey bookingId 기반 개선(슬롯 재예약 키 충돌 방지)
- Detection4 cancel key 동일 개선
- 한송이 수동 픽코 취소 처리 완료
- 관련 파일: `bots/reservation/auto/monitors/naver-monitor.js`
<!-- session-close:2026-03-05:취소-루틴-버그-수정-블러키-충돌:end -->

<!-- session-close:2026-03-05:예약-시간-파싱-버그-수정-openclaw-복구-덱스터 -->
#### 2026-03-05 🔧 예약 시간 파싱 버그 수정 + OpenClaw 복구 + 덱스터 오탐 수정
- naver-monitor 정오 종료시간 파싱 버그 수정
- pickko-accurate 경로 버그 수정
- logs.js Rate Limit 오탐 수정
- OpenClaw gemini-2.5-flash 복원
- OpenClaw fallback#3 gpt-4o 추가
- start-gateway.sh 래퍼 스크립트 생성(groq 키 하드코딩 제거)
- state.db 오류 예약 수동처리
- 관련 파일: `bots/reservation/auto/monitors/naver-monitor.js|bots/reservation/manual/reservation/pickko-accurate.js|bots/claude/lib/checks/logs.js|bots/claude/.checksums.json`
<!-- session-close:2026-03-05:예약-시간-파싱-버그-수정-openclaw-복구-덱스터:end -->

<!-- session-close:2026-03-05:스카-pickkoquerycancelcmd-경로-누락- -->
#### 2026-03-05 🔧 스카 pickko-query/cancel-cmd 경로 누락 버그 수정
- CLAUDE_NOTES.md 명령 테이블 절대경로 수정
- pickko-query.js 및 pickko-cancel-cmd.js 경로 누락 원인 파악
- 관련 파일: `bots/reservation/context/CLAUDE_NOTES.md`
<!-- session-close:2026-03-05:스카-pickkoquerycancelcmd-경로-누락-:end -->

<!-- session-close:2026-03-06:미해결-알림-반복-tool_code-누출-버그-수정 -->
#### 2026-03-06 🔧 미해결 알림 반복 + tool_code 누출 버그 수정
- pickko-alerts-resolve.js 신규 (수동 해결 CLI)
- CLAUDE_NOTES.md 처리완료 핸들러 추가
- CLAUDE_NOTES.md tool_code 누출 금지 규칙 추가
- 관련 파일: `bots/reservation/manual/reports/pickko-alerts-resolve.js|bots/reservation/context/CLAUDE_NOTES.md`
<!-- session-close:2026-03-06:미해결-알림-반복-tool_code-누출-버그-수정:end -->

<!-- session-close:2026-03-11:제이-무응답-4종-버그-수정 -->
#### 2026-03-11 🔧 제이 무응답 4종 버그 수정
- mainbot.js await 누락(items is not iterable)
- groupAllowFrom 미설정(그룹 메시지 드롭)
- OpenAI Groq rate limit → gemini 전환
- OpenClaw requireMention 기본값 변경 대응(groups.*.requireMention=false)
- 관련 파일: `bots/orchestrator/src/mainbot.js|.openclaw/openclaw.json`
<!-- session-close:2026-03-11:제이-무응답-4종-버그-수정:end -->

<!-- session-close:2026-03-11:navermonitor-kst-누락-수정 -->
#### 2026-03-11 🔧 naver-monitor kst 누락 수정
- naver-monitor.js kst 임포트 누락 → 알람 전송 실패 수정
- 관련 파일: `bots/reservation/auto/monitors/naver-monitor.js`
<!-- session-close:2026-03-11:navermonitor-kst-누락-수정:end -->

<!-- session-close:2026-03-11:취소감지4-오탐-수정-스캔-한도-300으로-상향 -->
#### 2026-03-11 🔧 취소감지4 오탐 수정 — 스캔 한도 300으로 상향
- 취소감지4 FUTURE_SCAN_LIMIT 50→300 (이영화 3/28 B룸 오탐 취소 원인)
- 스캔 한도 도달 시 stale 감지 스킵 안전장치 추가
- 오탐 cancelled_key(cancelid
- 1169988950) DB 삭제
- 이영화 픽코 수동 재등록 완료
- 관련 파일: `bots/reservation/auto/monitors/naver-monitor.js`
<!-- session-close:2026-03-11:취소감지4-오탐-수정-스캔-한도-300으로-상향:end -->

<!-- session-close:2026-03-12:버그헌팅-8건-수정-취소감지4-오탐중복빌링블로그 -->
#### 2026-03-12 🔧 버그헌팅: 8건 수정 (취소감지4 오탐/중복/빌링/블로그)
- 블로그 이어쓰기 중복 방지 (800자 tail+재시작감지)
- blo.js 중복실행 early-exit
- naver-monitor kst 임포트 누락 수정
- FUTURE_SCAN_LIMIT 50→300 + 스킵 안전장치
- 픽코 취소 중복 doneKey 통합
- 완료예약 허위취소 슬롯종료시간 기준 변경
- 빌링 API timeout DB캐시 폴백
- 패턴이력 26건 삭제
- 관련 파일: `bots/blog/lib/gems-writer.js|bots/blog/lib/pos-writer.js|bots/blog/lib/blo.js|bots/reservation/auto/monitors/naver-monitor.js|bots/reservation/auto/monitors/run-today-audit.sh|bots/reservation/manual/admin/run-verify.sh|bots/claude/lib/checks/billing.js`
<!-- session-close:2026-03-12:버그헌팅-8건-수정-취소감지4-오탐중복빌링블로그:end -->

<!-- bug-tracker:maintenance:start -->
- 🔧 `MAINT-008` [fix] **bug-report.js HANDOFF_FILE 경로 수정 (context/ 직접 참조)**
  2026. 2. 26. 19:57 · claude · `src/bug-report.js`
- 🚑 `MAINT-007` [hotfix] **테스트 예약 4건 취소 정리 (이재룡 3건 + 이승호 1건)**
  2026. 2. 26. 19:47 · claude · `src/pickko-cancel-cmd.js`
- 🔧 `MAINT-006` [fix] **pickko-cancel.js [7-B단계] 결제대기 예약 취소 폴백 추가**
  2026. 2. 26. 19:47 · claude · `src/pickko-cancel.js`
- ✨ `MAINT-005` [feature] **pickko-accurate.js [1.5단계] 회원 이름 자동 동기화 신규 추가**
  2026. 2. 26. 19:47 · claude · `src/pickko-accurate.js`
- 🚑 `MAINT-004` [hotfix] **cancelledSeenIds 오감지 취소 키 제거** *(→ BUG-002)*
  2026. 2. 24. 16:00 · claude · `naver-seen.json`
- 🚑 `MAINT-003` [hotfix] **.pickko-alerts.jsonl 초기 누적 항목 정리 (284건→3건)**
  2026. 2. 24. 15:50 · claude · `.pickko-alerts.jsonl`
- ⚙️ `MAINT-002` [config] **모니터링 주기 3분 → 5분 변경 (NAVER_INTERVAL_MS)**
  2026. 2. 24. 15:40 · claude · `src/start-ops.sh`
- 🚑 `MAINT-001` [hotfix] **010-3034-1710 나은애 픽코 수동 등록 완료 처리**
  2026. 2. 24. 15:30 · claude · `naver-seen.json`
<!-- bug-tracker:maintenance:end -->

## 최근 완료 작업 (2026-02-26 야간4) — pickko-daily-summary 매출 분리 구현

### 픽코 실제 매출 파싱 + 스터디카페/스터디룸 매출 분리

**배경:** 픽코 통계에는 스터디룸 결제금액이 포함되어 있어 순수 일반이용(키오스크) 매출과 혼재.
픽코 스터디룸 매출을 마이너스 처리해야 두 매출이 정확히 구분됨.

**공식:**
- 일반이용 매출 = 픽코 총매출 - 픽코 스터디룸 분
- 총매출 = 일반이용 + 스터디룸 (calcAmount 기준, 네이버 포함)

**변경 파일:**

| 파일 | 변경 내용 |
|------|----------|
| `lib/db.js` | daily_summary 테이블에 pickko_total/pickko_study_room/general_revenue 컬럼 추가 + ALTER TABLE 마이그레이션 |
| `lib/db.js` | upsertDailySummary/getDailySummary/getUnconfirmedSummaryBefore/getLatestUnconfirmedSummary/confirmDailySummary 업데이트 |
| `lib/pickko-stats.js` | (신규) fetchMonthlyRevenue/fetchDailyRevenue/fetchDailyDetail 구현 |
| `src/pickko-daily-summary.js` | 자정 보고에 [3-B단계] 픽코 매출 조회 추가, buildMessage에 일반이용 항목 표시 |
| `src/pickko-revenue-confirm.js` | 컨펌 메시지에 일반이용 매출 포함 |

**00:00 보고 메시지 형식 (변경):**
```
💰 매출 현황:
  일반이용: 12,000원       ← 픽코 실제 (fetchDailyDetail)
  스터디룸A1: 28,000원    ← calcAmount 계산
  스터디룸A2: 21,000원
  스터디룸B: 36,000원
  합계: 97,000원

❓ 오늘 매출을 확정하시겠습니까?
```

**컨펌 시 room_revenue 저장:** 스터디룸 각각 + 일반이용 항목 모두 저장

---

## 최근 완료 작업 (2026-02-26 야간2) — pickko-cancel [7-B단계] 결제대기 폴백 + 테스트 예약 정리

### 1. pickko-cancel.js — [7-B단계] 결제대기 폴백 추가

**문제:** `결제대기` 상태 예약은 [6단계]에서 주문상세 버튼이 존재하여 클릭 성공하지만, 이후 패널에 `a.pay_view`(상세보기)가 없음 → [7단계] 8초 타임아웃 후 오류

**해결:** [7단계] `a.pay_view` 미발견 시 [7-B단계] 폴백 추가
```
study/write/{sd_no}.html 이동 →
input#sd_step-1 (취소 radio, value="-1") 선택 →
작성하기 저장 → 취소 완료
```

**적용 케이스:** 결제대기 예약 (테스트 예약 등, 실제 결제 미완료 건)

### 2. 테스트 예약 전체 정리 (4건 취소 완료)

| 번호 | sd_no | 예약자 | 날짜/시간 | 룸 | 결과 |
|------|-------|--------|----------|---|------|
| 1 | 930082 | 이재룡 | 2026-07-05 19:00~20:00 | A1 | ✅ 취소 |
| 2 | 930087 | 이재룡 | 2026-07-05 20:00~21:00 | A1 | ✅ 취소 |
| 3 | 930090 | 이재룡 | 2099-12-31 01:00~02:00 | A1 | ✅ 취소 |
| 4 | 930089 | 이승호 | 2026-07-10 10:00~10:30 | A1 | ✅ 취소 |

모두 [7-B단계] 폴백으로 성공 처리.

---

## 최근 고정 규칙 (2026-03-16) — 예약 경로 회원정보 수정 금지

### 회원 이름 불일치는 자동수정하지 않고 알림만 발송

**운영 규칙:**
1. 예약/재등록 경로는 기존회원/신규회원 판별만 수행
2. 신규회원이면 회원등록 로직으로 이동
3. 기존회원이면 이름만 비교
4. 이름이 다르면 자동 수정 없이 `andy` 알림만 발송
5. 회원정보 수정은 마스터가 픽코 관리자에서 수동 처리

**현재 동작:**
- `pickko-accurate.js` 1.5단계는 `checkMemberNameMismatch()`만 수행
- 예약 경로에서 `회원 정보 수정` 버튼 클릭 금지
- 재등록 경로에서는 이름 동기화, 네이버 차단 모두 생략

**이유:**
- 예약 로직이 고객 마스터데이터를 변경하면 운영 위험이 큼
- 네이버 이름은 예약 입력값일 뿐, 내부 회원 원본값을 덮어쓰는 근거가 아님

---

## 최근 완료 작업 (2026-02-26) — pickko-accurate.js 달력 팝업 protocolTimeout 버그픽스

### pickko-accurate.js [5단계] [2단계] — `page.click()` → `page.evaluate()` 교체

**원인:** `page.click('input#start_date')` 호출 시 jQuery datepicker 클릭 핸들러가 동기 실행되면서 Puppeteer CDP `protocolTimeout` 기본값(180초=3분) 초과 → `Runtime.callFunctionOn timed out` exit code 1 발생 (간헐적, 평균 재시도 3회차 성공)

**수정:** `page.click()` 제거 → `page.evaluate()`로 jQuery datepicker API 직접 호출
```javascript
await page.evaluate(() => {
  const inp = document.querySelector('input#start_date');
  if (!inp) return;
  if (window.jQuery?.fn?.datepicker) window.jQuery(inp).datepicker('show');
  else inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});
```
- `datepicker('show')`: 팝업만 열고 즉시 반환 → CDP 블로킹 없음
- 폴백: jQuery 없으면 `MouseEvent` dispatchEvent (동일하게 non-blocking)

**검증:** naver-monitor PID 66050 재기동 후 정상 사이클 확인 (6:37 사이클 16초 소요)

---

## 최근 완료 작업 (2026-02-26) — pickko-cancel [6-B단계] 폴백 + 정진영 중복 예약 해소

### 1. pickko-cancel.js — [6-B단계] 폴백 추가 (0원/이용중 예약 취소)

**문제:** 결제금액 0원 또는 '이용중' 상태 예약은 픽코 상세 페이지에 '주문상세' 버튼이 없음 → `[6단계]` 에러로 자동 취소 실패

**해결:** `[6단계]` 실패 시 `[6-B단계]` 폴백 흐름 추가
```
수정 버튼 클릭 → /study/write/{sd_no}.html 이동 →
input#sd_step-1 (취소 radio, value="-1") 선택 →
작성하기 버튼 클릭 → 팝업 "수정되었습니다." 확인
```

**검증:** 정진영 010-2745-9103 / 2026-02-26 / A2 14:30~16:30 (0원 이용중 예약) 취소 성공
```
🧾 팝업 감지: 수정되었습니다.
✅ [SUCCESS] 픽코 예약 취소 완료 (수정→취소→저장 플로우)
```

### 2. 정진영 중복 예약 해소

- 010-2745-9103 / 2026-02-26 / A2 14:30~16:30 중복 예약 다수 발생
- Ska가 '신규 상태 여러 건' 감지 후 자동 취소 전 사장님께 보고 → **정상 안전 동작**
- 픽코 전체 상태 조회 결과: 해당 슬롯 예약 모두 해소 확인 (결제완료 기준 0건)
- 남은 건: 12:00~14:20 A2 결제완료 1건 (정상)

---

## 최근 완료 작업 (2026-02-26) — pickko-verify 자동 검증 범위 확장 + 운영 재개

### 1. lib/db.js — getUnverifiedCompletedReservations() 추가

`completed` 상태이지만 `pickkoStatus`가 `verified`/`manual`/`time_elapsed`가 아닌 항목 조회 (예: `paid`, `auto` 등 재검증 필요 건)

### 2. pickko-verify.js — collectTargets() 개선

- `getUnverifiedCompletedReservations()` 병합 → `completed/paid` 같은 미검증 완료 항목도 자동 포함
- 실행 결과: 윤길채 010-6451-1678 (2026-02-26 13:30~15:00 B룸) `completed/paid` → `completed/verified` 처리 완료

### 3. TIME_ELAPSED exit 2 테스트 완료

`MODE=ops`, 오늘 01:00~02:00 (이미 지난 시간)으로 pickko-accurate.js 실행
```
⏰ [6-0] 경과 슬롯 2개 스킵 (현재 11:58): 01:00~01:30 → 유효: []
⏰ [시간 경과] 픽코 등록 생략 → EXIT CODE: 2
```
정상 동작 확인.

### 4. 운영 재개

- openclaw gateway: PID 59105
- naver-monitor.js: PID 59166 (5분 주기, 2시간 자동 재시작)

---

## 최근 완료 작업 (2026-02-26) — SQLite 마이그레이션 + 픽코·네이버 엣지케이스 버그픽스

### 1. JSON → SQLite 마이그레이션 (lib/db.js + lib/crypto.js)

**변경 내용:** 분산 JSON 파일 → `~/.openclaw/workspace/state.db` 단일 SQLite DB로 통합

- `lib/crypto.js` 신규: AES-256-GCM 암호화/복호화, kiosk_blocks 해시 키 생성
- `lib/db.js` 신규: 스키마 초기화(WAL 모드), reservations / cancelled_keys / kiosk_blocks / alerts 테이블 + 전체 도메인 함수
- `scripts/migrate-to-sqlite.js` 신규: 기존 JSON 파일 1회 마이그레이션 (naver-seen → reservations, pickko-kiosk-seen → kiosk_blocks, .pickko-alerts.jsonl → alerts)
- `secrets.json`에 `db_encryption_key` (64자 hex) + `db_key_pepper` 추가 필요
- 전화번호(`phone_raw_enc`)·이름(`name_enc`) AES-256-GCM 암호화 (평문 DB 저장 제거)
- 버그 수정: `pruneOldCancelledKeys` import 누락 → naver-monitor.js `cleanupExpiredSeen()`에 추가

**영향 파일:** `src/naver-monitor.js`, `src/pickko-kiosk-monitor.js`, `src/pickko-daily-audit.js`, `src/pickko-verify.js`

---

### 2. pickko-accurate.js — 시간 경과 + 이미 등록된 슬롯 처리

**버그 1 — 시간 경과:** 예약 감지 시각이 10:59이고 시작 시각이 11:00이면, pickko-accurate.js 실행 시점에 11:00 슬롯이 사라짐 → 등록 실패

**수정:**
- `[6-0]` 블록 추가: 현재 KST 기준 `Math.ceil(nowMin/30)*30`으로 다음 슬롯 산출 → 경과 슬롯 필터링 (`effectiveTimeSlots`)
- 유효 슬롯 < 2개이면 `err.code = 'TIME_ELAPSED'` → `process.exit(2)` (새 종료코드)
- exit 2 = "시간 경과로 등록 불가" — failed(재시도)가 아닌 completed로 처리

**버그 2 — 이미 등록된 슬롯:** 재시도 중 슬롯이 이미 점유됐으면(`li[used]`) 무한 실패 → 재등록 시도

**수정:**
- `page.evaluate`에 `custName`, `phoneLast4` 전달
- `li[used]`의 `textContent` + `mb_no` + `mb_name` 속성으로 동일 고객 확인
- 일치하면 `err.code = 'ALREADY_REGISTERED'` → `process.exit(0)` (성공 처리)

**exit code 전파:** `naver-monitor.js`, `pickko-register.js`, `pickko-verify.js` 모두 exit 2 → `completed/time_elapsed` 처리 추가

---

### 3. pickko-kiosk-monitor.js — 네이버 차단 엣지케이스 처리

**버그 1 — 이미 차단된 슬롯:** 관리자가 수동으로 차단한 경우 `clickRoomAvailableSlot()` 실패 → 차단 실패로 기록

**수정 (blockNaverSlot 내부, Step 3.5):**
```javascript
const alreadyBlocked = await verifyBlockInGrid(page, room, start, end);
if (alreadyBlocked) {
  log(`  ✅ [이미 차단됨] ${room} ${start}~${end} 이미 예약불가 상태 → 차단 완료 처리`);
  return true;
}
```

**버그 2 — 시간 경과:** 배치 처리 중 예약 종료 시각이 지난 경우 차단 불필요한데 시도 → 실패 처리

**수정 (메인 루프):**
- `blockNaverSlot()` 호출 전 KST 기준 `e.date` + `e.end` 경과 여부 확인
- 경과 시: DB에 `naverBlocked: false`로 기록 (다음 주기 재시도 방지) + 텔레그램 알림 "⏰ 시간 경과 — 네이버 차단 생략"

---

## 최근 완료 작업 (2026-02-26) — telecram 직접 발송 + Phase 2B 버그 수정

### 1. lib/telegram.js — Telegram Bot API 직접 발송 모듈 신규

**문제:** `openclaw agent --deliver` 방식이 메시지를 LLM 입력으로 전달 → LLM이 재해석하여 원본 메시지 대신 LLM 응답("HEARTBEAT_OK")이 Telegram으로 전송됨. 야간 보류 알림도 유실.

**해결:** `lib/telegram.js` 신규 생성 — Telegram Bot API (`api.telegram.org/bot{TOKEN}/sendMessage`) 직접 호출, openclaw 완전 우회.

- 3회 재시도, 10초 타임아웃, `TELEGRAM_ENABLED=0` 환경변수로 비활성화
- `secrets.json`에 `telegram_bot_token`, `telegram_chat_id` 추가
- `naver-monitor.js`, `pickko-daily-audit.js`, `pickko-kiosk-monitor.js` 모두 `lib/telegram.js` import로 교체
- 야간 보류 로직 전체 제거 (flushPendingAlerts, pending-telegrams.jsonl 등) → 24시간 즉시 발송
- `CLAUDE_NOTES.md` 모델 정보 수정: `gemini-2.5-flash` → `gemini-2.0-flash`
- naver-monitor.js 재시작: PID 60760 → 71289

### 2. Phase 2B 필터 버그 수정 — pickko-kiosk-monitor.js

**버그:** Phase 2B 필터가 `naverBlocked=true` 여부 확인 없이 픽코 환불 항목 전체를 차단 해제 대상으로 포함. 결과적으로 seen 파일에 기록 없는 이재룡 `2026-02-26 11:00` 환불 건에 대해 불필요한 차단 해제 시도 → 날짜 선택 실패.

**수정 (1302~1311행):**
```javascript
// 이전: seen 파일 미등록 항목도 cancelledEntries에 포함됨
if (saved && saved.naverBlocked === false && saved.naverUnblockedAt) return false;

// 수정 후: naverBlocked=true로 실제 차단한 항목만 포함
if (!saved || saved.naverBlocked !== true) return false; // 차단 이력 없음
if (saved.naverUnblockedAt) return false; // 이미 해제 완료
```

**영향:** 차단한 적 없는 환불 예약에 대한 오동작 완전 차단.

---

## 최근 완료 작업 (2026-02-26) — 속도 테스트 툴 확인 + 모델 교체 검토

### LLM API 속도 테스트 (`scripts/speed-test.js`)

**확인 내용:** 프로젝트 루트에 `scripts/speed-test.js` 속도 테스트 툴이 존재함.

**결과 (2회 평균):**

| 순위 | 모델 | TTFT |
|------|------|------|
| 🥇 | `groq/llama-3.1-8b-instant` | 203ms |
| 🥈 | `groq/llama-4-scout-17b` | 211ms |
| 🥉 | `groq/llama-3.3-70b-versatile` | 225ms |
| 4위 | `gemini-2.0-flash` (현재 primary) | 608ms |
| 5위 | `ollama/qwen2.5:7b` | 811ms |
| ❌ | `gemini-2.5-flash` / `gemini-2.5-pro` | HTTP 429 (용량 초과) |

- `--apply` 플래그 사용 시 openclaw.json primary/fallback 자동 교체
- Groq 교체 여부는 다음 세션에서 결정 예정

---

## 최근 완료 작업 (2026-02-26) — pickko-kiosk-monitor.js fetchPickkoEntries 전환

### fetchKioskReservations 제거 → fetchPickkoEntries 재활용

**변경 내용:** 파일 내 중복 구현이었던 `fetchKioskReservations` 함수를 제거하고 `lib/pickko.js`의 `fetchPickkoEntries`로 교체

- `fetchKioskReservations` 함수 삭제 (~170줄)
- `normalizeTime` 로컬 함수 삭제 (~25줄, fetchPickkoEntries 내부에서 처리)
- Phase 1 결제완료 조회: `fetchPickkoEntries(page, today, { minAmount: 1 })`
- Phase 2B 환불 조회: `fetchPickkoEntries(page, today, { statusKeyword: '환불', minAmount: 1 })`

**위치:** `src/pickko-kiosk-monitor.js` import + Phase 1 + Phase 2B 호출부

**결과:** fetchPickkoEntries를 사용하는 스크립트 목록
| 스크립트 | 옵션 | 용도 |
|----------|------|------|
| `pickko-kiosk-monitor.js` | `{ minAmount: 1 }` | 키오스크 결제완료 조회 |
| `pickko-kiosk-monitor.js` | `{ statusKeyword: '환불', minAmount: 1 }` | 키오스크 환불 조회 |
| `pickko-verify.js` | `{ statusKeyword: '', endDate: date }` | 당일 전체 예약 (검증용) |
| `pickko-daily-audit.js` | `{ sortBy: 'sd_regdate', receiptDate: today, statusKeyword: '' }` | 접수일 기준 감사 |

---

## 최근 완료 작업 (2026-02-26) — pickko-daily-audit.js 일괄 조회 전환 + lib/pickko.js sd_regdate 지원

### lib/pickko.js fetchPickkoEntries 접수일시(sd_regdate) 모드 추가

**변경 내용:** `fetchPickkoEntries`에 `sortBy` + `receiptDate` 옵션 추가

- `sortBy: 'sd_regdate'` — 이용일시 필터 대신 접수일시 기준 정렬 (`o_key=sd_regdate` 라디오)
  - `sd_start_up`/`sd_start_dw` 날짜 입력 생략 (접수일 기준 조회 시 이용일 필터 불필요)
- `receiptDate: 'YYYY-MM-DD'` — 접수일 필터 (행 파싱 단계에서 적용)
  - 접수일시 내림차순 정렬 특성 활용: 대상일보다 이전 날짜 행 도달 시 `break` (조기 종료)
- `receiptTime` — colMap에 `접수일시` 컬럼 인덱스 추가
- `receiptText` — 반환 entry에 접수일시 원본 텍스트 포함

**위치:** `lib/pickko.js`

### pickko-daily-audit.js 5단계 제거 → fetchPickkoEntries 1회 호출

**변경 내용:** 기존 2~7단계(페이지 이동, 라디오 설정, 검색, colMap, 행 파싱, 정규화) → `fetchPickkoEntries` 1회 호출로 대체

- `fetchPickkoEntries(page, today, { sortBy: 'sd_regdate', receiptDate: today, statusKeyword: '' })`
- `normalizeTime` 로컬 함수 제거 (fetchPickkoEntries 내부에서 처리)
- 단계 수: 6단계 → 4단계 (로그인 → 일괄조회 → 비교 → 텔레그램)
- 코드량: ~250줄 → ~130줄

**위치:** `src/pickko-daily-audit.js`

---

## 최근 완료 작업 (2026-02-26) — pickko-verify.js 일괄 조회 전환 + lib/pickko.js 공유 함수 추가

### lib/pickko.js fetchPickkoEntries 공유 함수 추출

**변경 내용:** `pickko-kiosk-monitor.js`의 `fetchKioskReservations` 패턴을 공유 라이브러리로 추출

- `fetchPickkoEntries(page, startDate, opts)` 추가 — 픽코 어드민 스터디룸 예약 일괄 조회
  - `opts.statusKeyword` — 상태 필터 (`'결제완료'` 기본 / `''` = 전체)
  - `opts.endDate` — 이용일 종료 (기본 = `''` 무제한)
  - `opts.minAmount` — 이용금액 하한 (기본 = `0` 필터 없음, `1` = 키오스크 전용)
  - 반환: `{ entries: [{phoneRaw,name,room,date,start,end,amount}], fetchOk: boolean }`
- `_normalizeTime(str)` 내부 헬퍼 — 픽코 시간 문자열 → HH:MM 정규화

**위치:** `lib/pickko.js`

### pickko-verify.js N번 개별 검색 → 날짜별 일괄 조회 전환

**변경 내용:** 기존 N번 개별 `searchPickko(page, entry)` 호출 → `fetchPickkoEntries` 일괄 조회로 교체

- 대상 항목을 날짜별로 그룹화 → 고유 날짜 수만큼만 픽코 조회 (N번 → D번, D = 날짜 수)
- `fetchPickkoEntries(page, date, { statusKeyword: '', endDate: date })` 로 당일 전체 예약 조회
- 로컬 매칭: `phoneRaw === r.phoneRaw && r.start === entry.start`
- `fetchOk = false` 시 `searchPickko` 개별 검색 폴백 유지 (안전망)
- 항목 간 `delay(2000)` 제거 (조회 단계로 이동, 루프 불필요)

**위치:** `src/pickko-verify.js` imports + main() 함수

---

## 최근 완료 작업 (2026-02-26) — 취소 동기화 개선 (cancelledHref 파싱 실패 커버)

### naver-monitor.js 취소 감지 2 조건 개선

**변경 내용:** 취소 감지 2(`오늘 취소 탭 파싱`)의 실행 조건 개선

- **기존:** `cancelledCount >= 1` — 네이버 홈 카운터 파싱 실패 시(0 반환) 취소 탭 미방문
- **변경:** `cancelledCount >= 1 || !cancelledHref` — 카운터 파싱 실패로 `cancelledHref = null`인 경우에도 폴백 URL로 취소 탭 방문
- 정상 파싱 + count=0 → 방문 안 함(취소 없음 확실) / 파싱 실패 → 폴백 URL 방문

**변경 위치:** `src/naver-monitor.js` 라인 1367 조건식

---

## 최근 완료 작업 (2026-02-26 새벽3) — 키오스크 취소 → 네이버 차단 해제 자동화

### pickko-kiosk-monitor.js Phase 2B + 3B 추가

**변경 개요:** 키오스크 예약 취소 감지 → 네이버 예약불가 자동 해제

**Phase 2B: 취소 감지**
- `fetchKioskReservations` 반환값 변경: `entries[]` → `{ entries, fetchOk }`
  - `fetchOk`: 테이블 헤더 정상 로드 여부 (쿼리 실패 오감지 방지)
- `cancelledEntries` = seenData에서 `naverBlocked=true`인데 현재 `결제완료` 목록에 없는 것
  - 픽코에서 결제완료 → 환불완료 전환 시 자동 감지
  - `fetchOk=false`이면 Phase 2B 스킵 (오감지 방지)

**Phase 3B: 네이버 차단 해제**
- `unblockNaverSlot(page, entry)` — 차단 해제 메인 플로우
  - `verifyBlockInGrid()` 선체크: 이미 해제됐으면 → 그냥 `true` 반환 (수동 해제 처리)
  - `clickRoomSuspendedSlot()` → suspended 슬롯 클릭 → `fillAvailablePopup()` → 설정변경
  - 최종 `verifyBlockInGrid()` → `!blocked` 이면 해제 확인
  - 실패 시 `naverBlocked: true` 유지 → 다음 주기 자동 재시도
- 해제 성공 시: `seenData[key] = { ...e, naverBlocked: false, naverUnblockedAt }`
- 텔레그램: ✅ 해제 완료 / ⚠️ 수동 처리 필요

**새 함수:**
- `clickRoomSuspendedSlot(page, roomRaw, startTime)` — suspended 버튼 클릭
- `selectAvailableStatus(page)` — 예약불가 → 예약가능 드롭다운 선택
- `fillAvailablePopup(page, date, start, end)` — 시간+예약가능 설정+저장

**pickko-kiosk-seen.json 상태 변화:**
```json
// 차단: { naverBlocked: true, blockedAt: "..." }
// 해제: { naverBlocked: false, naverUnblockedAt: "..." }
```

**취소 감지 방식 변경 (픽코 직접 조회):**
- 기존: JSON 파일 비교 (naverBlocked=true 인데 결제완료 목록 없는 것)
- 변경: 픽코에서 `상태=환불, 이용금액>=1, 이용일>=오늘` 직접 조회 → 무결성 보장
- `fetchKioskReservations(page, today, '환불')` 로 호출 (기존 함수 재활용, statusKeyword 파라미터 추가)
- seenData에 `naverUnblockedAt` 있으면 이미 처리된 것으로 스킵

**테스트 방법:**
```bash
# 1. 픽코에서 키오스크 예약 환불 처리
# 2. node src/pickko-kiosk-monitor.js
# 예상: "[Phase 2B] 픽코 환불 예약 직접 조회" → "🗑 환불된 키오스크 예약: 1건"
#       → 네이버 상태 확인 → 차단 해제 or 이미 가능 처리
#       → 텔레그램 "✅ 네이버 예약불가 해제"
```

---

## 최근 완료 작업 (2026-02-26 새벽2) — 자연어 명령 확장 (조회·취소)

### pickko-query.js 신규

- 예약 조회 CLI — 날짜·이름·전화번호·룸 필터 지원
- 데이터 소스: `naver-bookings-full.json` (5분 주기 갱신)
- CLI: `--date=today|tomorrow|YYYY-MM-DD`, `--phone`, `--name`, `--room`
- stdout JSON `{ success, count, message, bookings }`
- 날짜별 그룹핑 + 시간순 정렬 메시지 자동 생성

### pickko-cancel-cmd.js 신규

- 스카 자연어 취소 명령용 래퍼 (stdout JSON)
- 내부적으로 `pickko-cancel.js` 스폰 (child logs → stderr, 부모 stdout = JSON 전용)
- CLI: `--phone, --date, --start, --end, --room, [--name]`
- stdout JSON `{ success, message [, partialSuccess, pickkoCancelled, naverUnblockFailed] }`
- `success: true`
  - 픽코 취소 + 네이버 해제까지 완료된 완전 성공
- `success: false` + `partialSuccess: true` + `pickkoCancelled: true` + `naverUnblockFailed: true`
  - 픽코 취소는 성공했지만 네이버 해제는 실패
  - 상위 응답 레이어는 "픽코 취소 완료, 네이버 수동 확인 필요"로 안내해야 함
- 2026-03-22 기준: 이 저장소 안에서는 부분 성공 계약을 분리했으며, 텔레그램 최종 문구가 여전히 완전 성공처럼 보이면 제이 상위 응답 레이어 해석을 점검해야 함

### CLAUDE_NOTES.md 업데이트

- 조회 명령 (`pickko-query.js`) 가이드 추가
- 취소 명령 (`pickko-cancel-cmd.js`) 가이드 추가
- 스카가 조회/취소 자연어 명령을 받으면 어떤 스크립트를 실행할지 명확화

---

## 최근 완료 작업 (2026-02-26 새벽) — 텔레그램 알람 안정성 + start-ops.sh self-lock

### start-ops.sh self-lock (중복 실행 방지)

- `SELF_LOCK=$HOME/.openclaw/workspace/start-ops.lock` 추가
- 실행 시 기존 PID 파일 확인 → 살아있으면 중복 차단 후 exit 1
- `trap "rm -f '$SELF_LOCK'" EXIT INT TERM` — 종료 시 자동 정리
- 여러 번 실행해도 단일 인스턴스만 유지됨

### 텔레그램 알람 안정성 개선 (naver-monitor.js)

**문제:** `sendTelegramDirect`가 fire-and-forget 방식으로 실패 시 메시지 유실

**해결:**
- `tryTelegramSend(message)` — exit code 0이면 true (10초 타임아웃)
- `sendTelegramDirect` → async, 3회 재시도 (3초/6초 백오프), 최종 실패 시 대기큐 저장
- `pending-telegrams.jsonl` 대기큐 — 다음 재시작 시 자동 재발송 (`flushPendingTelegrams`)
- **버그 수정**: `sendAlert`에서 `sent: inAlertWindow` (발송 전 true 기록) → `sent: false` 저장 후 성공 시 `updateAlertSentStatus`로 true 갱신
- `flushPendingAlerts` async 변환 — 발송 성공 확인 후 sent: true 업데이트
- `reportUnresolvedAlerts` async 변환 + await 추가
- 시작 시 `await flushPendingTelegrams()` 호출 추가

**팝업 fix (이전 세션):** "최초 로그인이 필요한 메뉴입니다." 팝업 — `btn.click()` → 좌표 클릭 + `Promise.all([waitForNavigation, click])`

### 현재 운영 상태

- start-ops.sh PID 60760 (self-lock 활성, 새 버전)
- naver-monitor.js PID 60991 (새 코드 적용, 정상 작동)

---

## 최근 완료 작업 (2026-02-25 오후) — 취소 로직 재작성 + 결제 플로우 개선

### pickko-cancel.js 취소 플로우 완전 재작성

기존 방식(sd_step=-1 라디오 선택)은 잘못된 흐름. 올바른 취소 플로우로 재작성:

**새 취소 흐름 [6~10단계]:**
1. 상세보기 진입 후 결제완료/결제대기 행의 **주문상세** 버튼 클릭
2. 팝업 모달 내 결제항목 **상세보기** 버튼 클릭 (결제완료 상태일 때만 존재)
3. 오른쪽 팝업에서 **환불** 버튼 클릭
4. "처리되었습니다" 확인 팝업 클릭

- ✅ `TARGET_STATUS` = `['결제완료', '결제대기']` — 두 상태 모두 처리 대상
- ✅ `DONE_STATUS` = `['환불완료', '환불성공', '취소완료']` — 중복 처리 방지 자동 감지
- ⚠️ **주의**: 환불 버튼은 결제완료 상태에서만 표시됨. 결제대기 상태는 주문상세 클릭 후 결제하기 버튼만 있음

### pickko-accurate.js SKIP_PRICE_ZERO=1 결제 플로우 개선

키오스크 시뮬레이션(이용금액 실제 금액 결제) 브랜치:
- ✅ `label[for="pay_type1_2"]` 현금 선택 추가 (`clickCashMouse()` 재활용)
- ✅ `#pay_order` 클릭 후 결제완료 DOM 팝업 확인(확인 버튼 클릭) 추가 [8-5]

### 테스트 예약 현황

| 주문번호 | 날짜 | 시간 | 결제 | 상태 |
|---------|------|------|------|------|
| 928880 | 2026-02-26 | 11:00~12:00 | 카드 0원 | 환불완료 (이전 세션) |
| 928882 | 2026-03-05 | 11:00~12:00 | 카드 0원 | 환불완료 (이전 세션) |
| 928895 | 2026-02-27 | 11:00~11:50 | 현금(대기) | **결제대기** — 취소 테스트용 |

> 928895 취소 테스트: 결제대기 → 결제완료 처리 후 `node src/pickko-cancel.js --phone 01035000586 --date 2026-02-27 --start 11:00 --end 12:00 --room A1` 실행 필요

---

## 최근 완료 작업 (2026-02-25 야간) — 테스트 예약불가 복원 + 임시 파일 전체 정리

### 테스트 예약불가 복원 확인

- `restore-available.js` 작성·실행 → 2026-02-25 테스트로 설정한 예약불가 4건 복원
- 복원 후 스크린샷(`/tmp/feb25-calendar.png`) 확인: `suspended` 클래스 0건 ✅
  - 화면의 A2룸 빨간 버튼은 `soldout(예약가능 0)` — 실제 확정 예약(이재룡) 있는 정상 상태
- 2026-03-02 이승호 B룸 18:00~20:00 예약불가는 실제 예약이므로 **유지**

### 루트 임시 파일 전체 정리

아래 파일 모두 삭제 (디버그·테스트용, 더 이상 불필요):
`add-test-booking.js`, `cancel-jaelyong.js`, `cancel-test-booking.js`, `complete-test-payment.js`,
`finalize-test-payment.js`, `finalize-test-payment2.js`, `inspect-pickko-form.js`,
`naver-browser-stub.js`, `restore-available.js`, `test-naver-parse.js`, `check-feb25.js`

---

## 최근 완료 작업 (2026-02-25 저녁) — 키오스크 모니터 검증 완료 + verifyBlockInGrid 수정

### pickko-kiosk-monitor.js verifyBlockInGrid 버그 수정 + 최종 검증

**수정 내용:**
- `verifyBlockInGrid()` 재작성: 이전 구현은 "예약불가" 필터 탭 텍스트가 페이지에 있으면 무조건 `verified:true` 반환하는 false positive 문제
- 수정 후: `suspended btn-danger-light` 클래스 버튼이 실제로 target 룸 X 범위 + 시작시간 Y 범위에 있는지 DOM 좌표 기반으로 확인
- 예약가능 슬롯 클래스: `avail btn-info-light` / 예약불가 슬롯 클래스: `suspended btn-danger-light`

**API 검증 결과 (CDP 인터셉트):**
```
PATCH https://api-partner.booking.naver.com/v3.1/businesses/596871/biz-items/4134332/schedules
Body: {"startDate":"2026-03-02","endDate":"2026-03-02","startTime":"18:00","endTime":"20:00","status":"OFF","stock":null}
HTTP 200 OK ✅
```

**최종 실행 결과:**
- 이승호 01062290586 | 2026-03-02 18:00~19:50 | 스터디룸B → 네이버 차단 확인
- `suspendedBtn: {cls: "btn btn-xs calendar-btn suspended btn-danger-light", x:643}` ✅
- 텔레그램: "🚫 네이버 예약 차단 완료 이승호 010-6229-0586 2026-03-02 18:00~19:50 스터디룸B" ✅

**주요 발견사항 (debugging):**
- 네이버 캘린더 Y 좌표: 오후 6:00 슬롯은 스크롤 후 Y≈865 (viewport 하단). 이전 check 스크립트가 Y>800 필터로 제외해서 "예약가능" 오판
- `stock:null` 전송 → API 200 OK (null=변경 없음으로 처리됨)
- `page.mouse.click()` vs `element.click()`: React SPA 날짜 피커는 반드시 mouse.click 필요

## 최근 완료 작업 (2026-02-25 낮~오후) — 픽코 키오스크 모니터 완전 구현

### pickko-kiosk-monitor.js — Phase 1~5 전체 완성 및 검증 완료

- ✅ **Phase 1**: 픽코 `이용금액>=1` 필터로 키오스크/전화 예약만 파싱 (네이버 자동 등록=0원 제외)
- ✅ **Phase 2**: `pickko-kiosk-seen.json` 상태 비교 → 신규 예약 감지
- ✅ **Phase 3**: 네이버 booking calendar 자동 차단 (CDP — naver-monitor 세션 재활용)
  - `DatePeriodCalendar__date-info` 클릭 → 2-month picker 팝업
  - 월 헤더 bounding rect 기반 날짜 셀 `page.mouse.click()` (공휴일 셀 startsWith 처리)
  - `BUTTON.form-control` (custom-selectbox) 클릭 → `BUTTON.btn-select` 옵션 선택
  - 종료시간 30분 올림: `roundUpToHalfHour()` (19:50 → 20:00)
  - CDP Frame detach 발생 시 새 탭으로 1회 자동 재시도
  - 예약상태 → 예약불가 선택 → 설정변경 클릭
- ✅ **Phase 4**: 텔레그램 알림 (차단 성공/실패 구분)
- ✅ **Phase 5**: 만료 항목 자동 정리 (date < today)
- ✅ `src/run-kiosk-monitor.sh` — launchd 래퍼 (중복 실행 방지 lock)
- ✅ `ai.ska.kiosk-monitor.plist` — 30분 주기 launchd 로드 완료
  - 로그: `/tmp/pickko-kiosk-monitor.log`
- ✅ `.gitignore` — `pickko-kiosk-seen.json` 추가 (전화번호 포함)

**테스트 결과**: 이승호 01062290586 | 2026-03-02 18:00~19:50 | 스터디룸B → 네이버 차단 완료 (`naverBlocked: true`)

---

## 최근 완료 작업 (2026-02-25 오전)

### 안정화 업데이트 8건 + 신규 스크립트 검증

- ✅ **C-1** `lib/files.js` `saveJson()` 원자적 쓰기 — tmp 파일 + rename (파일 손상 방지)
- ✅ **C-2** `pickko-verify.js` `markCompleted()` name 필드 유실 수정
- ✅ **C-3** `pickko-accurate.js` 시간 슬롯 재시도 1회 → 3회 (+ 1.5초 delay)
- ✅ **H-1** `naver-monitor.js` `rollbackProcessingEntries()` 추가 — exit 전 processing → failed 롤백
- ✅ **H-2** `start-ops.sh` 로그 파일 관리 — `LOG_FILE` 변수 + 1000줄 로테이션
- ✅ **H-3** `naver-monitor.js` `pruneSeenIds()` — seenIds 90일 초과 항목 정리 (기존 slice(-500) 대체)
- ✅ **H-4** `pickko-register.js` 성공 시 naver-seen.json에 `pickkoStatus: 'manual'` 기록
- ✅ **M-1** `naver-monitor.js` 사이클 타임 기반 슬립 조정 — 인터벌 드리프트 방지
- ✅ **M-2** `ai.ska.pickko-daily-audit.plist` 23:50 실행 추가 (22:00+23:50 2회)

### pickko-verify.js needsVerify() 개선

- ✅ `needsVerify()` 신규 — `completed + paid/auto` 항목도 검증 대상으로 처리
- 기존 임시 `status: 'pending'` 변경 우회 방식 완전 폐기
- 한송이 3건 backfill(1166777081/64/41) → `verified` 전환 완료

### 신규 스크립트 테스트 통과

- ✅ `pickko-daily-audit.js` — DOM 파싱·헤더 추출 정상 (당일 0건)
- ✅ `pickko-register.js` — 이재룡 01035000586 A1 예약 등록 성공 (`/study/view/928851.html`)
- ✅ `pickko-member.js` — 기존회원 감지 + 신규 회원 가입 모두 정상
  - ⚠️ 테스트 회원 `테스트 / 010-1234-1234` 픽코 admin에서 수동 삭제 필요

### OPS 시작 커맨드 업데이트

- `start-ops.sh` 내부에서 로그 리디렉션 처리 → 외부 `>>` 불필요
- 재시작 방법: `kill -9 <start-ops.sh PID>` 후 `nohup bash start-ops.sh > /dev/null 2>&1 &`

---

## 최근 완료 작업 (2026-02-24 오후)

- ✅ **모델 교체** — gemini-2.0-flash(deprecated) → `gemini-2.5-flash`
  - OpenClaw primary 모델 변경 + 게이트웨이 재시작 완료
  - Fallback: claude-haiku-4-5 → qwen2.5:7b 순 (openclaw.json 실제 설정 기준)

## 최근 완료 작업 (2026-02-24 낮)

- ✅ **야간 알림 차단** — `sendAlert()` 09:00~22:00 외 텔레그램 발송 차단
  - 야간: `.pickko-alerts.jsonl`에 `sent: false`로 파일에만 기록
  - `flushPendingAlerts()` 신규 — 09:00 첫 Heartbeat 시 보류 알림 일괄 발송
  - `morningFlushDone` 플래그 — 당일 1회만 실행
- ✅ **클로드↔봇 전달 채널 구축** — `CLAUDE_NOTES.md` 시스템
  - `context/CLAUDE_NOTES.md` 신규 생성 (클로드→스카 전용 채널 파일)
  - `registry.json` — openclaw 배포 파일 목록에 추가
  - BOOT.md 자동 재생성 (5. `CLAUDE_NOTES.md` 추가)
- ✅ **클로드 부팅 참조 시스템** — `SYSTEM_STATUS.md` 자동 생성
  - `deploy-context.js` — `updateSystemStatus()` 함수 추가
  - 봇 배포 시마다 모든 봇 상태·로그인방식·배포이력 자동 갱신
- ✅ **역할 정의 메모리 등록** — 클로드/스카 명칭 전체 문서에 기록

## 최근 완료 작업 (2026-02-24 오전)

- ✅ **공유 라이브러리 리팩토링** — lib/ 7개 신규 모듈 추출
  - `lib/utils.js` → delay, log
  - `lib/secrets.js` → loadSecrets()
  - `lib/formatting.js` → toKoreanTime, pickkoEndTime, formatPhone
  - `lib/files.js` → loadJson, saveJson
  - `lib/args.js` → parseArgs()
  - `lib/browser.js` → getPickkoLaunchOptions, setupDialogHandler
  - `lib/pickko.js` → loginToPickko()
- ✅ 4개 src 파일 중복 코드 제거 (node --check 전체 통과, 봇 재시작 확인)
- ✅ pickko-verify.js — pending/failed 예약 재검증 스크립트 신규 완성
- ✅ 개발문서 전체 업데이트 (README, DEV_SUMMARY, HANDOFF, IMPLEMENTATION_CHECKLIST)

## 최근 완료 작업 (2026-02-24 새벽)

- ✅ 취소 감지 방식 → `previousConfirmedList` 리스트 비교 (카운터 비교 폐기)
- ✅ 보안인증 대기 30분 + 텔레그램 알림 (원격 인증 처리 지원)
- ✅ 모니터링 주기 3분 (`NAVER_INTERVAL_MS=180000`)
- ✅ 새로고침 버튼 → `btn_refresh` selector 방식으로 수정
- ✅ `updateBookingState()`에 `name` 필드 추가
- ✅ Heartbeat 추가 (1시간 주기, 09:00~22:00만, `sendTelegramDirect`)
- ✅ `log-report.sh` 신규 생성 + launchd `ai.ska.log-report` 등록 (3시간 주기)

## 최근 완료 작업 (2026-02-23)

- ✅ `process.exit(0)` 버그 수정 - 픽코 성공 시 exit code가 1로 오인되던 문제
- ✅ `maxSlotsToTry` 미정의 변수 수정
- ✅ `OBSERVE_ONLY=0` OPS 시작 커맨드에 고정
- ✅ DEV/OPS 데이터 파일 분리 (`naver-seen-dev.json` / `naver-seen.json`)
- ✅ `start-ops.sh` 자동 재시작 루프 추가 (2시간 후 자동 재시작)
- ✅ `start-ops.sh` `cleanup_old()` 추가 - 재시작 시 구 프로세스 자동 종료
- ✅ `naver-monitor.js` 락 로직 개선 - 신규 시작 시 구 프로세스 SIGTERM→SIGKILL 처리
- ✅ 컨텍스트 관리 시스템 구축 (`registry.json` + `deploy-context.js`)
- ✅ `deploy-context.js` claude-code 타입 지원 추가
- ✅ MEMORY.md Heartbeat 모니터 생존 체크 지시 추가
- ✅ `nightly-sync.sh` + launchd 자정 자동 보존 시스템 구축
- ✅ BOOT.md 모델 변경 자동 컨텍스트 보존 - 게이트웨이 재시작 시 `deploy-context.js --sync` 1단계 자동 실행 (테스트 완료)
- ✅ detached Frame 버그 수정 - `runPickko()` 내 `naveraPage.close()` 제거 (픽코 실행 후 네이버 페이지 무효화 근본 해결)
- ✅ 수동 등록 예약 2건 seen 처리 완료
  - 010-2745-9103 (2026-02-26 14:30~16:30 A2) → completed/manual
  - 010-5681-7477 (2026-02-24 04:00~09:00 A1) → completed/manual

## 실제 등록 완료 예약

| 예약ID | 고객번호 | 날짜 | 시간 | 룸 | 상태 |
|--------|----------|------|------|-----|------|
| 1165071422 | 010-4214-0104 | 2026-02-28 | 16:00~18:00 | A1 | completed (auto) |

## OPS 시작 커맨드

```bash
cd ~/projects/ai-agent-system/bots/reservation/src
nohup bash start-ops.sh > /dev/null 2>&1 &
# 로그: /tmp/naver-ops-mode.log (start-ops.sh 내부에서 자동 리디렉션 + 1000줄 로테이션)
```

## 🗂️ 스카봇 기능 대기 목록 (다음 개발 예정)

### 🔜 다음 작업

| 순서 | 기능 | 설명 | 우선순위 |
|------|------|------|---------|
| 1 | 일일 예약 요약 자동 전송 | 매일 지정 시각에 예약 현황 요약 메시지 → 텔레그램 | 중간 |
| 2 | 예약 중복 감지 알림 | 동일 시간대 중복 예약 발생 시 즉시 경고 | 중간 |
| 3 | IS-001 홈화면 복귀 이슈 | session/cookie 만료 처리 개선 | 낮음 |
| 4 | Playwright → 네이버 API | UI 변경 취약점 근본 해결 (장기) | 장기 |
| 5 | 맥미니 이전 | M4 Pro 구매 후 전체 시스템 이전 | Phase 3 |

---

## 주의사항

- DEV 테스트 데이터는 절대 OPS로 처리하지 말 것
- 새 기능은 반드시 `MODE=dev`로 테스트 후 OPS 재시작
- `naver-seen.json`에는 실제 완료 예약만 보존

<!-- session-close:2026-03-02:재부팅-전-인수인계-스카팀 -->
#### 2026-03-02 🔄 재부팅 전 인수인계 — 스카팀 전체 현황

**✅ 이번 세션 완료 항목:**
- 취소 감지 교차검증: currentCancelledList 비교 → 이용완료 추정 시 cancelCancel 스킵
- SKA-P05~P08 루나팀 패턴 적용: error-tracker.js, mode.js, status.js, e2e-test.js (32/32)
- 3중 가동/중지 체계: lib/health.js + start-ops.sh 3중 체크 + SIGTERM/SIGINT 루프가드
- 예약 취소 E2E 완성: pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제)
- auditToday failedList 추가: 차단 실패 텔레그램 알림 "❌ 차단실패(수동필요)"

**현재 운영 상태 (재부팅 직전):**
- naver-monitor.js: OPS 운영 중 (PID 94318, 약 1시간, RSS 137MB)
- Puppeteer Chrome for Testing: 정상 동작 (세션 유지, ~1.3GB)
- 취소 감지 교차검증 로직: 활성화됨 (currentCancelledList 비교)
- 버그 현황: BUG-010~015 미해결 (픽코 자동 등록 실패, 픽코 서버 측 일시 지연 추정)
  → 재시도 로직 정상 동작 중, 심각한 코드 버그 아님

**재부팅 후 복구 절차:**
- launchd KeepAlive: ai.ska.naver-monitor, ai.ska.kiosk-monitor 자동 재시작 (30초 내)
- BOOT 완료: 약 60초 후 텔레그램 "준비 완료" 메시지
- 로그 확인: `tail -f /tmp/naver-ops-mode.log`
- 상태 확인: `skastatus` 명령

**주의사항:**
- 픽코 자동 등록 실패 (BUG-010~015): 픽코 서버 CDP 타임아웃 추정, 재시도 로직 정상
- 재부팅 후 첫 예약 등록 시 픽코 서버 응답 주시
- DEV 테스트 데이터는 절대 OPS로 처리 금지
<!-- session-close:2026-03-02:재부팅-전-인수인계-스카팀:end -->
