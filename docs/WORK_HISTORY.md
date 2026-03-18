# 작업 히스토리

> 날짜별 타임라인. "지난 주에 뭐 했지?" 빠른 파악용.
> 상세 내용: `reservation-dev-summary.md` / `reservation-handoff.md`
> 최초 작성: 2026-02-27

### 12주차 후속 (2026-03-18) — 워커 모니터링 + 투자 실행 모드 정합성 + 덱스터 경고 정리

핵심 구현:
- 워커 웹 관리자 메뉴에 `워커 모니터링` 추가
- `/admin/monitoring` 페이지에서 현재 워커 LLM API 적용 내용과 기본 provider 선택 드롭다운 추가
- `worker.system_preferences` 테이블 신설로 워커 웹 기본 LLM API 선택값 저장
- 워커 관리자 분석 경로(`/api/ai/ask`, `/api/ai/revenue-forecast`)가 선택한 provider를 우선 사용하도록 반영
- 투자팀 `executionMode` / `brokerAccountMode` 기준을 코드와 문서에 정리
- 투자 실패 원인 저장을 `block_reason + block_code + block_meta` 구조로 확장
- `weekly-trade-review.js`를 보조 입력 실패에 더 강인하게 보정
- 덱스터 `shadow mismatch`를 저위험 코드 무결성 이슈에서 `soft match`로 재해석해 과장 경고 정리

세션 맥락:
- 워커는 문서 재사용 추적 이후, 운영자가 실제 LLM 공급자 경로를 제어할 수 있는 관리 레이어까지 올라왔다.
- 투자팀은 자산과 직접 연결되는 실행 모드 의미를 다시 고정하면서 운영 리포트 해석 기준을 정리했다.
- 덱스터는 false positive를 줄여 실제 운영 경고만 남기도록 보정했다.

의사결정 이유:
- 워커 LLM 모니터링은 기존 `llm_mode` 정책을 깨지 않고, 관리자 분석 경로의 기본 provider만 별도 축으로 제어하는 것이 안전하다.
- 투자팀은 `paper/live`만으로는 자산/계좌 의미가 섞여서, `executionMode`와 `brokerAccountMode`를 분리하는 쪽이 운영과 SaaS 확장 모두에 유리하다.
- 덱스터는 `monitor`와 `ignore` 차이를 모두 오류로 올리면 운영 피로도가 커지므로, 저위험 dev-state는 완화해서 보는 것이 맞다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/lib/ai-client.js`
- `node --check bots/worker/web/server.js`
- `cd bots/worker/web && npm run build`
- `node bots/worker/scripts/health-report.js --json`
- `node bots/investment/scripts/trading-journal.js --days=7`
- `node bots/claude/scripts/health-report.js --json`

### 12주차 후속 (2026-03-18) — 스카 shadow 비교 + 워커 문서 재사용 추적

핵심 구현:
- 스카 예측 엔진에 `knn-shadow-v1` shadow 비교 모델 추가
- `forecast_results.predictions`에 `shadow_model_name`, `shadow_yhat`, `shadow_confidence` 저장
- 스카 일일/주간 리뷰가 `primary vs shadow` 비교를 읽도록 확장
- 스카 자동화 프롬프트를 shadow 관찰/승격 판단 기준으로 갱신
- 워커 문서 재사용 흐름에 문서 상세, 재사용 이벤트, 생성 결과 연결, 전환율 요약 추가
- 일일 운영 분석 리포트 입력 스크립트 `scripts/reviews/daily-ops-report.js` 추가 및 fallback 과장 진단 완화
- 구현 추적 문서를 `docs/PLATFORM_IMPLEMENTATION_TRACKER.md`로 이름 변경하고 세션 인덱스/팀 문서 링크 정리
- 세션 시작/종료 문서 흐름을 `SESSION_CONTEXT_INDEX.md`, `WORK_HISTORY.md`, `RESEARCH_JOURNAL.md` 중심으로 재정리

세션 맥락:
- 스카는 기존 엔진을 교체하지 않고 `shadow`로만 비교를 시작했다.
- 워커는 문서 파싱 기능을 넘어서 실제 업무 생성 결과와 성과를 추적하는 단계로 넘어갔다.
- 운영 분석은 과한 추론보다 보수적 판단을 우선하는 방향으로 입력 구조를 조정했다.

의사결정 이유:
- 스카는 내부 MVP와 운영 안정성을 위해 `대체`보다 `shadow 비교`가 맞다.
- 워커는 새 레이어를 만들기보다 기존 문서 저장/업무 confirm 흐름을 확장하는 것이 더 안전하다.
- 세션 문서는 같은 성격을 나누기보다 기존 문서에 흡수해 읽는 순서를 줄이는 것이 맞다.

검증:
- `python3 -m py_compile bots/ska/src/runtime_config.py bots/ska/src/forecast.py`
- `node --check scripts/reviews/daily-ops-report.js`
- `node --check scripts/reviews/ska-sales-forecast-daily-review.js`
- `node --check scripts/reviews/ska-sales-forecast-weekly-review.js`
- `cd bots/worker/web && npm run build`

### 10~11주차 (3/11~3/15) — 228개 커밋

핵심 구현:
- KST 시간 유틸리티 (packages/core/lib/kst.js) + 전 팀 적용 + launchd KST 수정
- KNOWN ISSUES 5개 개선 (mini 폴백 + screening DB + XSS + gemini maxTokens)
- CLAUDE.md 공통 원칙 8개 추가 (6대 원칙 + 노드화 + LLM + 보안)
- 소스코드 접근 권한 제한 (file-guard.js + 덱스터 화이트리스트)
- 루나 노드화 파이프라인 스캐폴딩 (debate + decision + risk + execution)
- 루나 스크리닝 강화 (해외 + 암호화폐 휴리스틱)
- 루나 매매일지 자동 리뷰 + 엑스커전 + 리스크 연동
- 스카 예측 캘리브레이션 + 피처스토어 + 모멘텀
- 워커 WebSocket 실시간 채팅 + 태스크 러너 + 승인
- 제이 인텐트 자동 프로모션 + 롤백 + 감사 추적
- 통합 OPS 헬스 (루나 리스크 + 스카 예측 + 클로드 품질 + 워커)
- 팀별 개별 헬스 리포트 (루나/스카/클로드/워커/블로)
- 공유 헬퍼 리팩터링 42개
- 블로그팀 plist Hour 수정 (UTC21→KST6) + 수동 발행 38강+홈페이지와App
- 워커 웹 모바일 버그 수정 (SSE→XHR, 툴칩 애니메이션, 채팅 중복 메시지)
- 워커 웹 클로드코드 채팅 메시지 버블 병합 (도구 실행 중 텍스트 하나로 합침)

---

### 빌링 버그 수정 + 오발동 수정 + 보안 업그레이드 (2026-03-13)

**빌링 합산 버그 수정**
- `bots/claude/lib/checks/billing.js`: API 누적값을 SUM으로 더해 $79.92 뻥튀기 → `DISTINCT ON (provider, date)`로 최신값만 합산
- 실제 금액 확인: $19.98 (Anthropic $16.42 + OpenAI $3.56), 월말 예상 $47.65

**완료 예약 허위 취소 오발동 수정**
- `bots/claude/lib/checks/ska.js`: 이용 완료 후 `cancelled_keys`에 dedup 키가 잔류해 매 체크마다 오발동
- 케이스 B(이용 완료 감지) 시 해당 키를 `cancelled_keys`에서 자동 정리하도록 수정

**Picco 취소 재시도 추가**
- `bots/reservation/auto/monitors/naver-monitor.js`: `runPickkoCancel` 실패 시 60초 후 1회 자동 재시도
- Playwright 타임아웃으로 인한 일시적 실패 자가복구 가능

**npm audit 워크스페이스 경로 + PATH 수정**
- `bots/claude/lib/checks/deps.js`: 모노레포 하위 패키지에 lock 파일 없어 audit 스킵되던 문제 해결
- 루트에서 `--workspace` 플래그로 실행, `execSync` env에 PATH 추가

**오정은 (010-7184-8299) 3/29 예약 manual 처리**
- `pickko_status`: `verified` → `manual` (픽코 수동 등록 완료)

**보안 패키지 업그레이드**
- ccxt 4.5.42 → 4.5.43
- bcrypt 5.1.1 → 6.0.0 (tar / node-pre-gyp high 취약점 해결)
- npm audit: 2 high → 0 vulnerabilities
- groq-sdk: Breaking change로 업그레이드 보류

**PATCH_REQUEST.md 처리 완료 후 삭제**

**덱스터 최종 상태**: ❌ 0건 / ⚠️ 2건 (경미, 시간 지나면 소멸)

---

### 덱스터 알람 개선 + 스카팀 LLM 교체 (2026-03-12)

**스카팀 LLM 교체**
- `bots/registry.json`: reservation/ska 모델 `gemini-2.5-flash` → `groq/llama-4-scout-17b-16e-instruct`, fallback `openai/gpt-4o-mini`
- deploy-context.js 재실행 → BOOT.md 반영 완료

**dexter_error_log upsert 방식으로 변경**
- `bots/claude/lib/error-history.js`: INSERT → ON CONFLICT DO UPDATE (occurrence_count 누적)
- `getPatterns()`: COUNT(*) → occurrence_count 컬럼 기준으로 변경
- DB 마이그레이션: 기존 106행 → unique constraint 추가 후 12행으로 정리

**dexter-quickcheck.js 알람 레벨 개선**
- failCount 기반 분기: 1회 실패 → ⚠️ alert_level 2 (경고), 2회+ 연속 → 🚨 alert_level 4 (CRITICAL)

**dexter.js 신규 오류만 텔레그램 발송**
- `bots/claude/src/dexter.js`: `hasIssue` → `hasCritical || newErrors.length > 0` 로 변경
- `getNewErrors` import 추가
- 효과: 반복 오류는 발송 안 하고, 최근 2시간 내 처음 등장한 오류 또는 CRITICAL만 알림

**naver-monitor.js 버그 수정 (이전 세션 연속)**
- 취소 성공 시 DB status 미업데이트 수정
- 취소감지4 OBSERVE_ONLY 필터 누락 수정

**체크섬 갱신**
- `bots/claude/.checksums.json`: 42개 파일 갱신

**LLM 속도 테스트 실행**
- groq/gpt-oss-20b 152ms 🥇, llama-3.1-8b 153ms 🥈 (현재 스카팀 llama-4-scout는 464ms로 6위)

### 전 팀 LLM 모델 최적화 + 스카팀 재가동 (2026-03-11)

**루나팀 llm-client.js v2.4 — 에이전트 라우팅 재배치**
- `GROQ_AGENTS`: `['nemesis', 'oracle']` (athena/zeus 제거)
- `MINI_FIRST_AGENTS` 신규: `['hermes', 'sophia', 'zeus', 'athena']` → gpt-4o-mini 메인 + scout 폴백
- `callOpenAIMini()` 함수 신규 추가
- `callGroq()` 폴백: gpt-4o → **gpt-4o-mini**로 변경 (비용 절감)

**블로그팀 LLM 폴백 체인 변경**
- `pos-writer.js`, `gems-writer.js`: 2순위 `gpt-oss-20b` → `gpt-4o-mini`
- `star.js`: 단일 chain → gpt-4o-mini + llama-4-scout 폴백 추가

**클로드팀 LLM 최적화**
- `claude-lead-brain.js`: LLM_CHAIN에서 `claude-sonnet-4-6` 제거 → `gpt-4o → gpt-4o-mini → scout`
- `archer/config.js`: OPENAI.model `gpt-4o` → `gpt-4o-mini`

**루나팀 스크리닝 장애 대응 인프라 (변경 7)**
- `screening-monitor.js` 신규: 연속 실패 횟수 추적 + 3회 이상 시 텔레그램 알림 (2h 중복 방지)
- `pre-market-screen.js`: `PRESCREENED_FILE`에 `crypto` 추가, `loadPreScreenedFallback()` 신규 (24h TTL RAG 폴백)
- `domestic.js`, `overseas.js`: 아르고스 성공 시 `savePreScreened()` 저장, 실패 시 RAG 폴백 → 없으면 빈 배열
- `crypto.js`: 동일 RAG 폴백 패턴 적용 (최후 폴백: config.yaml 기본 종목)

**스카팀 완전 재가동**
- 구 프로세스 정리: ska.js(22143), start-ops.sh(22637), naver-monitor.js(57001)
- Chrome SingletonLock 제거, 스테일 락 파일 정리
- kickstart: ska.commander(59200), naver-monitor(59205/59289), kiosk-monitor(59390/59398)
- kiosk-monitor 이전 exit 1 (02:10 Navigation timeout) → 재기동 후 정상

**체크섬 갱신**: `bots/claude/.checksums.json`

---

### API 빌링 추적 + 아처 비용 트렌드 리포트 (2026-03-10)

**덱스터 billing.js 체크 모듈 신규**
- Anthropic Admin API (`GET /v1/organizations/costs`) + OpenAI Usage API 월간 실비용 수집
- `claude.billing_snapshots` 테이블 자동 생성 (provider, date, cost_usd, UNIQUE(provider,date))
- 예산 초과(100%)/경고(80%) + 일일 급등(전일 대비 N배) 감지
- `dexter.js`에 `billing` 체크 모듈 등록

**llm-keys.js 확장**
- `getAnthropicAdminKey()`: `anthropic.admin_api_key` 또는 `ANTHROPIC_ADMIN_API_KEY` 환경변수
- `getBillingBudget()`: 예산 설정 (anthropic $50 / openai $30 / total $80 / spike_threshold 3.0)

**아처 비용 트렌드 리포트**
- `analyzer.js`: `buildBillingTrendSection()` 추가 — 최근 7일 일별 비용 테이블 + 월간 소진율/예상 월말 비용
- `reporter.js`: `buildMarkdownWithBilling()` 추가 — 아처 리포트에 💰 LLM 비용 트렌드 섹션 자동 삽입

**config.yaml 업데이트**
- `anthropic.admin_api_key` 필드 추가 (빈 값, 별도 설정 필요)
- `billing` 섹션 추가: budget_anthropic/openai/total, spike_threshold

**체크섬 갱신**: 35개 파일 갱신 (`bots/claude/.checksums.json`)

---

### 스카팀 취소감지1 더블체크 + 블로팀 품질 강화 (2026-03-10)

**스카팀 naver-monitor**
- 취소감지1 오동작(7건 자동취소) 긴급 수정
- pendingCancelMap 도입: 미래예약 사라짐 1차감지 → 1사이클 후 재확인, 2회 연속 미감지 시만 취소 실행
- 30분 만료 폴백 로직 추가

**블로팀 img-gen.js 신규**
- gpt-image-1 high quality 이미지 생성 (대표 1장 + 중간 1장)
- 젬스(일반 포스팅) 전용 적용, 포스(강의)는 이미지 없음
- output/images/ + 구글드라이브 자동 저장

**블로팀 publ.js 버그 수정 3가지**
- inPre 블록 미리셋 → 코드블록 내 일반 줄 처리 오류 수정
- `**bold**` → `<strong>` 변환 누락 수정
- 제목 첫 줄 중복 HTML 출력 방지

**블로팀 pos-writer.js 커리큘럼 제목 강제 준수**
- writeLecturePost / writeLecturePostChunked(A/B/C 그룹) 모두에 ★★★ 지시 추가
- "제목의 핵심 키워드를 그대로 다루어야 한다, 다른 기술로 대체 금지" 명시

**blog.curriculum 120강 ver2.2 전체 업데이트**
- 다운로드 파일 기준 전체 120강 제목 일괄 업데이트 (기존 120강 전부 변경)
- 35강: 데이터베이스 마이그레이션 → Redis 1 인메모리 DB 캐싱 전략으로 변경 등

**글자수 기준 최종 확정**
- 포스(강의): min 8,000자 / goal 9,000자
- 젬스(일반): min 7,000자 / goal 8,000자 (내부 이어쓰기 트리거 7,500자)
- gems-writer _THE_END_ 조건 제거 → 짧은 완성본도 이어쓰기 강제

**내일(2026-03-11) 발행 준비 완료**
- 35강: Redis 1 인메모리 DB 캐싱 전략 (9,292자, DB ID:27)
- 최신IT트렌드: AI와 최신 기술이 만들어가는 새로운 미래 (9,853자, DB ID:32, 이미지 2장)



## 2026-03-12
### 🔧 버그헌팅: 8건 수정 (취소감지4 오탐/중복/빌링/블로그)
- 블로그 이어쓰기 중복 방지 (800자 tail+재시작감지)
- blo.js 중복실행 early-exit
- naver-monitor kst 임포트 누락 수정
- FUTURE_SCAN_LIMIT 50→300 + 스킵 안전장치
- 픽코 취소 중복 doneKey 통합
- 완료예약 허위취소 슬롯종료시간 기준 변경
- 빌링 API timeout DB캐시 폴백
- 패턴이력 26건 삭제
<!-- session-close:2026-03-12:버그헌팅-8건-수정-취소감지4-오탐중복빌링블로그 -->

### ✨ 종목 범위 확대: CoinGecko+ApeWisdom+KIS순위+FNG 연동
- CoinGecko Trending 병합 (크립토 트렌딩 보너스 20%)
- ApeWisdom WSB 멘션 집계 (해외주식 보완)
- KIS volume-rank API (국내주식 1순위 소스)
- Alternative.me FNG 기반 max_dynamic 자동 조절
- 후보 풀 확대: 크립토 30→50, 동적 3→7/5/5
- 버그1 blo.js early-exit DB오류 오스킵 수정
- 버그2 ska.js kst 미사용 수정
<!-- session-close:2026-03-12:종목-범위-확대-coingeckoapewisdomkis -->

### ✨ 미추적 BTC 흡수·직접매수·USDT폴백 구현
- 미추적 BTC 흡수 (같은 심볼 BUY 신호)
- BTC 직접 페어 매수 _tryBuyWithBtcPair (ETH/BTC 등)
- USDT 폴백 _liquidateUntrackedForCapital
- CoinGecko·ApeWisdom·FNG Rate Limit 처리 추가
- 다음 세션: 자본관리 대공사 (BTC를 capital로 인식)
<!-- session-close:2026-03-12:미추적-btc-흡수직접매수usdt폴백-구현 -->

### ✨ 루나팀 BTC 자본 인식 대공사
- capital-manager: getUntrackedBtcUsd() 헬퍼 추가
- capital-manager: getAvailableBalance() = USDT + 미추적 BTC
- capital-manager: getAvailableUSDT() 리포팅 전용 분리
- capital-manager: getTotalCapital() BTC 포함
- capital-manager: getCapitalStatus() BTC 내역 추가
- hephaestos: 미추적 BTC 흡수 (같은 심볼)
- hephaestos: _tryBuyWithBtcPair() BTC 직접 페어 매수
- hephaestos: _liquidateUntrackedForCapital() USDT 폴백
<!-- session-close:2026-03-12:루나팀-btc-자본-인식-대공사 -->

### 🔧 report.js absorb/liquidate 사이드 알림 포맷 추가
- notifyTrade absorb·liquidate·buy·sell 사이드 이모지 분기
- memo 필드 텔레그램 출력 추가
<!-- session-close:2026-03-12:reportjs-absorbliquidate-사이드-알 -->

### 🔧 워커팀 웹 UI 모바일 버그 수정
- 모바일 메뉴바 닫힘(setCanvasLocked ReferenceError 제거)
- 세션 싱글탭(onTouchStart 빈핸들러+group-hover제거)
- 세션 전환 내용 섞임(캐시제거+activeSessionRef동기화)
- 페이지-드로어 스크롤 간섭(overscroll-contain+body.overflow)
- 툴칩 레벨 정렬(pl-9)
- 스크롤 이슈(overscroll-contain+touch-action)
<!-- session-close:2026-03-12:워커팀-웹-ui-모바일-버그-수정 -->

### 🔧 워커팀 웹 UI 모바일 버그 수정 완료
- setCanvasLocked ReferenceError 제거
- iOS 싱글탭(onTouchStart+group-hover제거)
- 세션전환 내용섞임(캐시제거+ref동기화)
- 스크롤 간섭(overscroll-contain)
- 체크섬 갱신 42개
<!-- session-close:2026-03-12:워커팀-웹-ui-모바일-버그-수정-완료 -->

### ✨ 워커웹 UI개선 및 매출데이터 정합성 수정
- DataTable 페이지네이션(10건/pageSize prop)
- 매출데이터 90일치 날짜오프셋 수정(daily_summary 기준 재입력)
- sales API TO_CHAR date 수정(KST오프셋 버그 해결)
- 3/10~3/11 스카 매출 신규 입력
- 문서관리 삭제버튼 btn-danger 통일
- 사이드바/헤더 높이 h-16 정렬
- DataTable 빈행 채우기 제거
<!-- session-close:2026-03-12:워커웹-ui개선-및-매출데이터-정합성-수정 -->

### 🔧 스타봇 BLOG_INSTA_ENABLED opt-out 수정
- blo.js BLOG_INSTA_ENABLED opt-in→opt-out(!=false) 수정
- 수동 누락 포스트 42(37강)·43(성장과성공) 스타 카드 재실행 완료
<!-- session-close:2026-03-12:스타봇-blog_insta_enabled-optout- -->

### ✨ 젬스 분량 보완 — 뉴스 분석 섹션 + 보너스 확률 상향
- IT 카테고리 뉴스 분석 섹션 추가(700자+, 최신IT트렌드·IT정보와분석·개발기획과컨설팅)
- 보너스 인사이트 확률 상향(0개40%→20%, 2개25%→40%)
- section-ratio body_1·body_2 기본값 1800→2000자
- MIN_CHARS_GENERAL 7500→8000, 목표 8000→9000자
- 시스템프롬프트 본론 최소글자 1500→2000자
<!-- session-close:2026-03-12:젬스-분량-보완-뉴스-분석-섹션-보너스-확률-상향 -->

### 🔧 워커웹 채팅 중복 메시지 수정
- isSendingRef 추가(동기 중복 전송 방지)
- loadMessages 경쟁 조건 수정(스트리밍 중 DB 덮어쓰기 방지)
- 어시스턴트 메시지 key={i}→key={g.key} 버그 수정
<!-- session-close:2026-03-12:워커웹-채팅-중복-메시지-수정 -->

## 2026-03-11
### ✨ 강의 인스타 페어링 + 캐시 실패방지 + launchd INSTA 환경변수 + 이미지 medium 품질
- runLecturePost 강의 인스타 콘텐츠 페어링 추가 (BLOG_INSTA_ENABLED)
- img-gen.js quality=high→medium (OPENAI_IMAGE_QUALITY 환경변수 제어)
- gems-writer.js+pos-writer.js 글자수 미달 시 캐시 저장 건너뜀 (실패 결과 캐시 방지)
- schedule.js BLOG_RUN_DATE 오버라이드 + _today() 함수 추가
- launchd ai.blog.daily.plist BLOG_INSTA_ENABLED=true 추가 + reload
- DB 수동 보정: category_rotation 35/5, publish_schedule 3/10 카테고리 수정
<!-- session-close:2026-03-11:강의-인스타-페어링-캐시-실패방지-launchd-ins -->

### ✨ 루나팀 국내외장 공격적 매매 전환 (2주 검증)
- luna.js MIN_CONFIDENCE/FUND_MIN_CONF 마켓별 객체 차등
- luna.js LUNA_SYSTEM_CRYPTO/STOCK + getLunaSystem() 분기
- luna.js 투표 폴백 완화 (주식 vote>=0&&conf>=0.3=BUY)
- nemesis.js NEMESIS_SYSTEM_CRYPTO/STOCK + getNemesisSystem() 분기
- nemesis.js RULES_CRYPTO/STOCK + getRules() 분기 (주식 MAX_ORDER_USDT 2000)
- nemesis.js evaluateSignal rules=getRules(signal.exchange) 전면 교체
- scripts/pre-market-screen.js 신규 (장전 아르고스 스크리닝 → JSON 저장)
- domestic.js 장전 스크리닝 우선 로드 + 보유 포지션 추가
- overseas.js 동일 패턴 적용
- launchd prescreen-domestic(KST 08:00)+prescreen-overseas(KST 21:00) 2개 신규
<!-- session-close:2026-03-11:루나팀-국내외장-공격적-매매-전환-2주-검증 -->

### ✨ 블로그팀 차기 강의 시리즈 자동 선정
- curriculum-planner.js 신규 (종료 7강 전 트리거, HN+GitHub 트렌드, LLM 후보 3개, generateCurriculum)
- 003-curriculum-tables.sql 마이그레이션 (curriculum_series 신규 + 기존 curriculum 확장)
- blo.js dailyCurriculumCheck() 매일 호출 + transitionSeries() 시리즈 자동 전환
- schedule.js curriculum-planner getNextLectureTitle 우선 조회 연동
- DB: curriculum_series 생성 (Node.js 시리즈 active) + 기존 120강 series_id 연결 완료
<!-- session-close:2026-03-11:블로그팀-차기-강의-시리즈-자동-선정 -->

### ✨ 전 팀 LLM 최적화 + 스크리닝 RAG 폴백 + 스카팀 재가동
- llm-client MINI_FIRST_AGENTS+callOpenAIMini
- pos/gems-writer gpt-4o-mini 폴백
- star.js scout 폴백
- claude-lead-brain sonnet 제거
- archer gpt-4o-mini
- screening-monitor.js 신규
- RAG 폴백 24h TTL
- 스카팀 kickstart 재가동
<!-- session-close:2026-03-11:전-팀-llm-최적화-스크리닝-rag-폴백-스카팀-재가 -->

### 🔧 제이 무응답 4종 버그 수정
- mainbot.js await 누락(items is not iterable)
- groupAllowFrom 미설정(그룹 메시지 드롭)
- OpenAI Groq rate limit → gemini 전환
- OpenClaw requireMention 기본값 변경 대응(groups.*.requireMention=false)
<!-- session-close:2026-03-11:제이-무응답-4종-버그-수정 -->

### 🔧 naver-monitor kst 누락 수정
- naver-monitor.js kst 임포트 누락 → 알람 전송 실패 수정
<!-- session-close:2026-03-11:navermonitor-kst-누락-수정 -->

### 🔧 젬스/포스 이어쓰기 중복 방지 + 중복실행 early-exit
- gems-writer.js 이어쓰기 800자 tail + LLM 재시작 감지
- pos-writer.js 동일 패턴 적용
- blo.js 모두 발행 완료 시 early-exit
<!-- session-close:2026-03-11:젬스포스-이어쓰기-중복-방지-중복실행-earlyexit -->

### 🔧 취소감지4 오탐 수정 — 스캔 한도 300으로 상향
- 취소감지4 FUTURE_SCAN_LIMIT 50→300 (이영화 3/28 B룸 오탐 취소 원인)
- 스캔 한도 도달 시 stale 감지 스킵 안전장치 추가
- 오탐 cancelled_key(cancelid
- 1169988950) DB 삭제
- 이영화 픽코 수동 재등록 완료
<!-- session-close:2026-03-11:취소감지4-오탐-수정-스캔-한도-300으로-상향 -->

## 2026-03-10

### 블로그팀 장문 출력 극대화 5가지 방법 적용

**Continue 이어쓰기 + _THE_END_ 마커 + exhaustive 키워드 + temperature 조정**
- `pos-writer.js`: Continue 패턴 (MIN 7,000자 미달 시 2차 호출), _THE_END_ 마커, exhaustive 키워드, temperature 0.75→0.82
- `gems-writer.js`: 동일 패턴, temperature 0.80→0.85
- `quality-checker.js`: MIN 강의 9,000 / 일반 5,000 / GOAL 강의 10,000 / 일반 7,000
- **테스트 결과**: 강의 10,225자 ✅ / 일반 5,500자 ✅

### 블로그팀 분할 생성(Chunked Generation) + llm-keys 폴백 + 글자수 튜닝

**분할 생성 완성**
- `packages/core/lib/chunked-llm.js` 신규: `callGemini` / `callGpt4o` / `chunkedGenerate`
- `pos-writer.js`: `writeLecturePostChunked()` 4청크 추가 (group_a~d, 각 1,500~2,000자)
- `gems-writer.js`: `writeGeneralPostChunked()` 3청크 추가 (group_a~c)
- `blo.js`: `BLOG_LLM_MODEL=gemini` 환경변수로 전체 파이프라인 Gemini 분할 생성 전환

**llm-keys 폴백 적용**
- `pos-writer.js`, `gems-writer.js`, `chunked-llm.js`: `process.env.OPENAI_API_KEY` → `getOpenAIKey()` 교체
- 키 조회 순서: `config.yaml` → 환경변수

**글자수 기준 튜닝 (실측 기반)**
- quality-checker MIN/GOAL: 강의 7,000/9,000 / 일반 4,500/7,000
- gems 시스템 프롬프트: 6,000 → 7,000자 / 목표 8,000 → 8,500자
- gems 유저 프롬프트: 본론 섹션 1,500 → 2,000자씩

**테스트 결과**: ✅ 강의 8,122자 / ✅ 일반 4,602자 통과

---

### ✨ 블로그팀 소셜봇 + 이미지 생성 완성
- N40/N42 Gemini→OpenAI(gpt-4o-mini) 전환
- N41 인스타 카드 gpt-image-1+sharp 한글 합성
- img-gen.js Nano Banana 메인+OpenAI High 폴백 신규 구현
- 이모지→AI 배경 힌트 전략(EMOJI_HINT 맵)
- llm-keys getGeminiImageKey() 추가
- llm-logger SQL timestamptz 수정
- gpt-oss-20b reasoning_effort:low 추가
- Gemini thinkingBudget:0 추가
<!-- session-close:2026-03-10:블로그팀-소셜봇-이미지-생성-완성 -->

### ✨ 동적 인사이트 4~6개 + 내부 링킹 과거만 + 소셜→스타
- bonus-insights.js 신규 (봇별 보너스 풀 + 랜덤 선택)
- section-ratio.js 신규 (섹션별 글자수 동적 배분, 보너스 순수 추가)
- social.js→star.js 이름 변경 + blo.js 참조 변경
- maestro.js bonusInsights+totalInsights 추가
- pos-writer.js 보너스 인사이트 지시 + 내부 링킹 과거만 Phase 1
- gems-writer.js 동일 패턴 적용
- richer.js searchRelatedPosts currentLectureNum 필터 추가
- registry.json blog-social→blog-star
<!-- session-close:2026-03-10:동적-인사이트-46개-내부-링킹-과거만-소셜스타 -->

### ✨ 일자별 발행 스케줄 + 테스트 정책 + 도서리뷰 실제 도서 기반
- publish_schedule 테이블 마이그레이션(002-publish-schedule.sql)
- schedule.js 신규 (getTodayContext/updateScheduleStatus/ensureSchedule 등)
- book-research.js 신규 (네이버 책API→Google Books→폴백 베스트셀러)
- gems-writer.js 도서리뷰 특별 프롬프트 블록 추가
- blo.js 스케줄 기반 오케스트레이션으로 전면 개편 (category-rotation→schedule.js)
<!-- session-close:2026-03-10:일자별-발행-스케줄-테스트-정책-도서리뷰-실제-도서-기 -->

## 2026-03-09

### 워커팀 Phase 4 AI 고도화 완료 + rag-system 잔재 제거 (`0bfaa70`~`a21ce69`)

**버그 수정 (이전 세션 이어)**
- `sophie.js`: `base_salary` 하드코딩 → DB 컬럼 참조
- `POST /api/payroll/calculate`: `companyFilter` 누락 추가
- `POST /api/schedules`, `POST /api/sales`: `companyFilter` 누락 추가
- Rate limit 핸들러 JSON 형식 수정, 한글 파일명 인코딩 수정
- `GET /api/projects/:id` 신규 추가, `DELETE /api/documents/:id` 신규 추가
- `pickko-daily-audit.js`: `await collectNaverKeys()` 누락 수정

**Phase 4: AI 자연어 질문 + 매출 예측**
- `lib/ai-client.js` 신규: `callLLM()` + `callLLMWithFallback()` (Groq 우선 → Haiku 폴백)
- `lib/ai-helper.js` 신규: SQL 생성/요약 프롬프트, `isSelectOnly()`, `isSafeQuestion()`
- `POST /api/ai/ask`: 자연어 → SQL → 실행 → RAG → 요약 파이프라인 (admin/master 전용)
- `POST /api/ai/revenue-forecast`: 90일 매출 → Groq 분석 → 30일 예측
- 감사 로그: `ai_question`, `ai_forecast` 자동 기록
- `web/app/ai/page.js` 신규: AI 질문 폼 + 예시 칩 + 데이터 테이블 + 매출 예측
- `Sidebar.js`: admin/master 전용 AI 분석 메뉴 추가
- launchd 키 관리: `start-worker-web.sh` 래퍼로 `config.yaml`에서 런타임 로드

**보안 강화**
- `isSafeQuestion()`: 입력 질문에 DELETE/DROP 등 차단 (입력 단계 차단)
- `isSelectOnly()`: 생성된 SQL SELECT 전용 검증 (이중 방어)

**rag-system 잔재 제거**
- `~/projects/rag-system/` 제거 (백업: `~/backups/rag-system-backup-20260309.tar.gz`)
- `scripts/migrate-rag.js` 삭제 (마이그레이션 완료)
- `network.js`, `migrate` 스크립트 3종, `llm-cache.js`, `rag-server.js` ChromaDB 주석 정리

**미완 — RAG 임베딩**
- OpenAI 쿼터 초과 → RAG store/search 실패 (try-catch로 조용히 무시)
- **맥미니 도착 후** Ollama `nomic-embed-text`로 전환 예정

### ✨ RAG 완성 + 에이전트 오케스트레이션 Phase 2 + 보안패치
- RAG pgvector 전 컬렉션 완성 (9곳 Node.js + 2곳 Python)
- 스카팀 Python RAG 클라이언트 rag_client.py 신규
- forecast.py + rebecca.py RAG 연동
- 에이전트 오케스트레이션 Phase 2 MessageEnvelope + trace_id + tool-logger
- 009 마이그레이션 tool_calls 테이블 + trace_id 컬럼
- multer CVE 보안패치 + 5개 패키지 minor 업데이트
<!-- session-close:2026-03-09:rag-완성-에이전트-오케스트레이션-phase-2-보안 -->

### ✨ 네메시스 Phase 3 R/R 최적화
- analyze-rr.js 신규 — 8가지 TP/SL 시뮬레이션+봇정확도+RAG저장
- nemesis.js getDynamicRR() ESM export 추가
- weekly-trade-review.js buildRRSection() 주간 R/R 섹션 통합
- package.json analyze-rr 스크립트 추가
<!-- session-close:2026-03-09:네메시스-phase-3-rr-최적화 -->

### ✨ 클로드팀 개선 5가지 + 스카팀 개선 4가지
- bot-behavior.js 신규(독터 루프+실패율+루나급속)
- doctor.js 복구실패 RAG 학습 + getPastSuccessfulFix
- claude-lead-brain.js Shadow 4단계(CLAUDE_LEAD_MODE 환경변수)
- 헬스 대시보드 포트3032(npm run health)
- deps.js 패치 티켓 자동생성
- 스카 커맨더 RAG 연동(searchPastCases+storeAlertContext)
- 예약 현황 대시보드 포트3031(npm run dashboard)
- forecast.py 동적 가중치(MAPE 역수 기반)
- weather.py classify_weather_impact(API 재호출 없음)
<!-- session-close:2026-03-09:클로드팀-개선-5가지-스카팀-개선-4가지 -->

## 2026-03-08 (계속)

### RAG 자동 수집 파이프라인 + 팀장 RAG 연동 완성 (커밋: `7630fc8`)

**구현 완료:**
- `reporter.js` — 덱스터 ERROR/WARN 점검 결과 → rag_operations 저장
- `doctor.js` — 독터 복구 성공 이력 → rag_operations 저장
- `archer.js` — 아처 주간 기술 보고 (patches/security/llm_api) → rag_tech 저장
- `luna.js` — 매매 신호 확정 → rag_trades 저장 + LLM 전 유사 신호 검색·주입
- `claude-lead-brain.js` — shadow_log 후 분석 결과 → rag_operations 저장 + LLM 전 유사 장애 검색·주입

**최종 자동 수집 파이프라인:**
```
✅ 매매 완료       → rag_trades      (luna.js)
✅ 독터 복구       → rag_operations  (doctor.js)
✅ 덱스터 CRITICAL → rag_operations  (reporter.js)
✅ 아처 기술 보고  → rag_tech        (archer.js)
❌ nightly git log → 제거 (아처와 중복, 불필요한 임베딩 비용)
```

**설계 원칙:** 모든 RAG 저장/검색은 try-catch + console.warn 보호 — 실패해도 본 로직 무영향

**테스트 결과: 20/21 PASS** (A-5 nightly git log → 불필요하여 의도적 미구현)

---

### ✨ 루나팀 개선 3/3 — 소피아+아리아 고도화
- 소피아 Fear&Greed Index 추가 (alternative.me, 1시간 캐시)
- 소피아 combineSentiment() 다중소스 통합 (커뮤니티0.5+FG0.3+뉴스0.2)
- 소피아 analyzeSentiment 5분 결과 캐시
- 아리아 CRYPTO_TIMEFRAMES 3→4개 확장 (15m/1h/4h/1d)
- 아리아 calculateAutoWeights() 변동성 기반 동적 가중치
- 아리아 DB 메타데이터에 weights 추가
<!-- session-close:2026-03-08:루나팀-개선-33-소피아아리아-고도화 -->

### ✨ 클로드팀 완전체 개선 + 루나팀 자본관리
- team-bus.js 에러핸들링(try-catch 0→15개)
- dexter-mode.js 에러핸들링 보강(5→16개)
- Phase2 agent_state DB 기반 팀장 무응답 감지
- Phase3 Emergency 폴백 직접복구(emergencyDirectRecover)
- 루나팀 자본관리 완전체(capital-manager.js 신규)
- 루나팀 신호 pending→approved 전환 버그 수정
- 헤파이스토스 SELL 바이낸스 실잔고 폴백
- reporter.js ROUND 타입 버그 수정
<!-- session-close:2026-03-08:클로드팀-완전체-개선-루나팀-자본관리 -->

### ✨ 워커팀 Phase 1 기반 구축 완료
- worker 스키마+4개 테이블
- bcrypt+JWT 인증
- 업체 격리 미들웨어
- REST API 서버(포트4000)
- 워커팀장 텔레그램 봇
- Web 로그인/대시보드
- launchd ai.worker.web 등록
<!-- session-close:2026-03-08:워커팀-phase-1-기반-구축-완료 -->

### ✨ Phase 3 소피/라이언/클로이 + OWASP 로그 + 웹 대시보드
- DB 마이그레이션 005 (6테이블)
- sophie.js 급여봇
- ryan.js 프로젝트봇
- chloe.js 일정봇
- OWASP logger.js (계정잠금/민감필드마스킹)
- server.js Phase 3 API 라우트
- payroll/page.js
- projects/page.js
- projects/[id]/page.js
- schedules/page.js
- Sidebar Wallet/FolderKanban/Calendar
- Dashboard 6카드
<!-- session-close:2026-03-08:phase-3-소피라이언클로이-owasp-로그-웹-대시 -->

## 2026-03-08

### 제이 자연어 능력 향상 v2.0 (커밋: `4c9efa1`)
- **intent-parser.js 전면 재작성**
  - Intent 36→53개 (+17개): shadow_report, shadow_mismatches, llm_cost, cache_stats, llm_graduation, dexter_report, dexter_quickcheck, doctor_history, analyst_accuracy, analyst_weight, trade_journal, trade_review, trade_performance, tp_sl_status, stability, telegram_status, unrecognized_report, promote_intent, chat
  - 신규 슬래시 명령: /shadow, /graduation, /stability, /journal, /performance, /unrec, /promote
  - CoT 2단계 + Few-shot 10개 예시 → LLM 프롬프트 품질 향상
  - `loadDynamicExamples()`: unrecognized_intents DB에서 5분 캐시로 동적 Few-shot 주입
  - 최종 폴백: unknown → chat (자유 대화 허용)
  - **버그 수정**: ska_query 패턴 bare `|통계` 제거 → "캐시 통계" 오매칭 방지
- **router.js 대규모 확장**
  - unrecognized_intents PostgreSQL 테이블 (claude 스키마) + `logUnrecognizedIntent()`, `buildUnrecognizedReport()`, `promoteToIntent()`
  - chat 폴백 2단계: TEAM_KEYWORDS regex → `delegateToTeamLead()` → `geminiChatFallback()`
  - 17개 신규 case 핸들러: Shadow 리포트, LLM 졸업, 투자 일지, 덱스터 즉시 실행 등
  - HELP_TEXT v2.0: 전체 명령 반영 + 자동학습 안내 섹션
- 테스트: 24/24 케이스 통과
- 체크섬 갱신 (9개 파일)

### OpenClaw 게이트웨이 설정 오류 수정
- **원인**: `~/.openclaw/openclaw.json`에 `agents.teamLeads` 미인식 키 → config 유효성 실패 → exitCode: 1 반복
- **수정**: `openclaw doctor --fix` → 키 자동 제거
- **패턴 이력 초기화**: OpenClaw 메모리 반복 패턴 8건 삭제
- **덱스터 결과**: ❌ 0건, ⚠️ 2건 (OpenClaw 메모리 518MB — 추이 관찰)

### 변경 파일
- `bots/orchestrator/lib/intent-parser.js` (전면 재작성)
- `bots/orchestrator/src/router.js` (대규모 확장)
- `~/.openclaw/openclaw.json` (코드 외 설정 파일)

---







### ✨ Phase 1 — 루나팀 전환판단 + LLM졸업실전 + 덱스터팀장봇연동
- shadow-mode.js getTeamMode/setTeamMode 추가
- luna-transition-analysis.js 신규
- router.js luna_confirm/luna_shadow/luna_analysis 케이스
- run-graduation-analysis.js 신규
- weekly-stability-report.js weeklyValidation 연동
- reporter.js emitDexterEvent (agent_events 이중경로)
- claude-lead-brain.js processAgentEvent/pollAgentEvents
- dexter.js emitDexterEvent+pollAgentEvents 연결
- processAgentEvent payload TEXT 파싱 버그 수정
- db-backup pg_dump 절대경로 버그 수정 (이전 세션 이어)
- pickko-daily-audit manualCount TDZ 버그 수정 (이전 세션 이어)
- 테스트 14/14 전체 통과
- 스카팀 매출 데이터 체크 (마이그레이션 타이밍 이슈, 정상화)
- 포캐스트 학습데이터 0일 오류 분석 (정상화)
- pickko-daily-audit+db-backup launchd exit 1 갱신
<!-- session-close:2026-03-08:phase-1-루나팀-전환판단-llm졸업실전-덱스터팀장 -->

## 2026-03-07
### ✅ Day 7 — 통합 테스트 + 1주차 마무리
- 통합 테스트 5개 카테고리 전체 통과 (State Bus / 덱스터+독터 / 매매일지 / 크로스팀 / LLM 인프라)
- 1주차 문서화 완료 (work-history / dev-journal / CHANGELOG / SESSION_HANDOFF)
- 안정화 기준선 v3.2.0 설정 (docs/TEST_RESULTS.md)
<!-- session-close:2026-03-07:day-7-통합-테스트-1주차-마무리 -->

### 🔧 오탐 근본 수정 + Day 6 검증 완료
- markResolved() 추가 (ok 복귀 시 error 이력 자동 삭제)
- dexter.js markResolved 호출 통합
- Day 6 검증 15/15 전체 통과
<!-- session-close:2026-03-07:오탐-근본-수정-day-6-검증-완료 -->

### ✨ Day 6 — 독터 + 보안 강화 + OPS/DEV 분리
- doctor.js 신규 (화이트리스트 5개, 블랙리스트 9개, doctor_log 테이블)
- mode-guard.js 신규 (ensureOps / ensureDev / runIfOps)
- deploy-ops.sh 신규 (배포 전 5단계 점검)
- scripts/pre-commit에 config.yaml 차단 추가
- security.js pre-commit 훅 설치/권한 점검 추가
- markResolved() 추가 (오탐 근본 수정 — ok 복귀 시 error 이력 자동 삭제)
<!-- session-close:2026-03-07:day-6-독터-보안-ops-dev-분리 -->

### ✨ Day 5 — OpenClaw 멀티에이전트 구조
- packages/core/lib/team-comm.js 신규 (팀장 간 소통, State Bus 기반)
- packages/core/lib/heartbeat.js 신규 (팀장 생존 확인 + 이벤트 폴링)
- openclaw.json agents.teamLeads 등록 (ska / claude-lead / luna)
- SOUL.md 3개 생성 (ska / claude-lead / luna — 팀장 페르소나)
<!-- session-close:2026-03-06:day-5-openclaw-멀티에이전트 -->

### ✨ PostgreSQL 단일 DB 통합 마이그레이션 완료 (Phase 5~6)
- forecast.py psycopg2 마이그레이션
- ska 스키마 PostgreSQL 초기화 (setup-db.py)
- duckdb npm 제거 (investment)
- better-sqlite3 npm 제거 (reservation,orchestrator)
- KI-003 취약점 해결 (npm audit 0)
- CHANGELOG v3.3.0
- KNOWN_ISSUES KI-003 해결
<!-- session-close:2026-03-07:postgresql-단일-db-통합-마이그레이션-완료- -->

### ✨ 3주차 구축 — 클로드(팀장) Sonnet Shadow + 장애주입 테스트 + LLM 졸업 엔진
- claude-lead-brain.js — Sonnet Shadow 판단 엔진 신규
- dexter.js Shadow 연동 + await 누락 수정
- scripts/chaos/ 장애 주입 5종 스크립트
- llm-graduation.js LLM 졸업 엔진 신규
- analyst-accuracy.js 분석팀 정확도 추적 신규 (ESM)
- Groq↔OpenAI 양방향 폴백 (skipFallback 무한루프 방지)
- 오류패턴분석 메타루프 수정
- pickko-verify process.exit(0) 누락 수정
<!-- session-close:2026-03-07:3주차-구축-클로드팀장-sonnet-shadow-장애주 -->

## 2026-03-06
### 🔧 미해결 알림 반복 + tool_code 누출 버그 수정
- pickko-alerts-resolve.js 신규 (수동 해결 CLI)
- CLAUDE_NOTES.md 처리완료 핸들러 추가
- CLAUDE_NOTES.md tool_code 누출 금지 규칙 추가
<!-- session-close:2026-03-06:미해결-알림-반복-tool_code-누출-버그-수정 -->

### ✨ Day 4 — 루나팀 매매일지 시스템
- trade-journal-db.js 신규 (5개 테이블 + DB함수)
- report.js notifyJournalEntry + notifyDailyJournal 추가
- hephaestos.js 매매일지 자동 기록 연동
- nemesis.js trade_rationale 자동 기록 연동
- schema_migrations v4 등록
- DuckDB 5개 신규 테이블 생성 확인
<!-- session-close:2026-03-06:day-4-루나팀-매매일지-시스템 -->

## 2026-03-05
### ✨ 출금지연제 자동예약 + 덱스터 Phase C
- 출금지연제 delay 감지·ETA 계산·Telegram 안내
- 자동 출금 예약(withdraw-schedule.json)
- 루나 커맨더 30초 폴링 자동 실행
- 덱스터 신규감지 중복버그 수정
- 신규감지 창 24h→8h
- 시간표시 UTC→KST
- --clear-patterns CLI
- batched 자동정리
- RAG 서버 optional 처리
<!-- session-close:2026-03-05:출금지연제-자동예약-덱스터-phase-c -->

### 🔧 덱스터 Phase C 버그수정 + 업비트 출금지연 자동예약
- deps.js cd→cwd 수정 (launchd PATH 오류)
- git 상태 패턴 저장 제외 (false positive)
- getNewErrors 중복 수정 (GROUP BY)
- node→process.execPath 수정 (code/database/ska.js)
- 업비트 출금지연제 자동예약 (luna-commander)
- 마스터 절대규칙 등록
- RAG 상세 로드맵 등록 (improvement-ideas)
<!-- session-close:2026-03-05:덱스터-phase-c-버그수정-업비트-출금지연-자동예약 -->

### 🔧 헬스체크 회복 로직 + 제이 할루시네이션 방지 + db-backup 수정
- health-check.js 회복 감지·알림·state 저장 로직 추가
- backup-db.js async 누락 수정
- intent-parser.js 스카 점검 패턴 추가
- TOOLS.md 제이 bot_commands 명령 테이블 + 할루시네이션 방지 경고 추가
- 전체 흐름 테스트 완료 (회복 알림 텔레그램 수신 확인)
<!-- session-close:2026-03-05:헬스체크-회복-로직-제이-할루시네이션-방지-dbback -->

### 🔧 취소 루틴 버그 수정 (블러/키 충돌)
- page.click(body)→Escape 키 수정(상세보기 블러 문제)
- toCancelKey bookingId 기반 개선(슬롯 재예약 키 충돌 방지)
- Detection4 cancel key 동일 개선
- 한송이 수동 픽코 취소 처리 완료
<!-- session-close:2026-03-05:취소-루틴-버그-수정-블러키-충돌 -->

### ✨ 루나팀 국내/국외 모의투자 배포
- 국내장 모의투자 활성화 (ai.investment.domestic)
- 국외장 서비스 확인 (ai.investment.overseas)
- 포트폴리오 프롬프트 심볼 환각 버그 수정 (luna.js)
- 덱스터 신호 exchange 불일치 감지 추가 (database.js)
- Claude API 크레딧 소비 원인 분석 (OpenClaw Gemini OAuth 만료→Haiku 폴백)
<!-- session-close:2026-03-05:루나팀-국내국외-모의투자-배포 -->

### ✨ LLM 토큰 이력 DB 기록 + 거래 일지 스크립트
- llm-client.js Groq/OpenAI 토큰·응답시간 DB 기록
- token-tracker.js duration_ms + gpt-4o 단가 추가
- token_usage 테이블 duration_ms 컬럼 추가
- scripts/trading-journal.js 신규 (매매일지 CLI)
<!-- session-close:2026-03-05:llm-토큰-이력-db-기록-거래-일지-스크립트 -->

### ✨ OpenClaw 업데이트 + 제이 RAG 연동 + e2e 데이터 정리
- OpenClaw 2026.2.26→2026.3.2 업데이트
- 제이 TOOLS.md RAG 검색 섹션 추가 (system_docs 12건 임베딩)
- state.db e2e 테스트 데이터 4건 삭제 (2099-01-01)
<!-- session-close:2026-03-05:openclaw-업데이트-제이-rag-연동-e2e-데이 -->

### 🔧 예약 시간 파싱 버그 수정 + OpenClaw 복구 + 덱스터 오탐 수정
- naver-monitor 정오 종료시간 파싱 버그 수정
- pickko-accurate 경로 버그 수정
- logs.js Rate Limit 오탐 수정
- OpenClaw gemini-2.5-flash 복원
- OpenClaw fallback#3 gpt-4o 추가
- start-gateway.sh 래퍼 스크립트 생성(groq 키 하드코딩 제거)
- state.db 오류 예약 수동처리
<!-- session-close:2026-03-05:예약-시간-파싱-버그-수정-openclaw-복구-덱스터 -->

### 🔧 스카 pickko-query/cancel-cmd 경로 누락 버그 수정
- CLAUDE_NOTES.md 명령 테이블 절대경로 수정
- pickko-query.js 및 pickko-cancel-cmd.js 경로 누락 원인 파악
<!-- session-close:2026-03-05:스카-pickkoquerycancelcmd-경로-누락- -->

## 2026-03-04 (세션 3)
### ✅ 제이↔클로드 통신·NLP자동개선·정체성유지 시스템 — 완료

**완료 항목:**
- **제이↔클로드 직접 통신**: `/claude`, `/ask` 슬래시 명령 → `ask_claude` bot_command → `claude -p headless` (5분 타임아웃)
- **LLM 명칭 일반화**: `parseGemini` → `parseLLMFallback`, `GEMINI_MODEL` → `LLM_FALLBACK_MODEL/PROVIDER` — LLM 교체 시 두 줄만 변경
- **NLP 4단계 파싱**: slash → learned → keyword → LLM fallback (소스 태그: 'slash'|'learned'|'keyword'|'llm')
- **NLP 자동개선 루프**: 미인식 명령 → `analyze_unknown` bot_command → Claude가 JSON 응답(user_response + 패턴) → `nlp-learnings.json` 저장 → intent-parser.js 5분 리로드
- **팀장 정체성 점검**: `identity-checker.js` — 제이가 6시간마다 3개 팀장 COMMANDER_IDENTITY.md 점검·자동 복원
- **팀원 정체성 점검**: 스카(4명) / 루나(10명) / 클로드(5명) 각 팀장이 6시간마다 bot-identities JSON 갱신
- **커맨더 정체성 능동 유지**: 각 커맨더 `BOT_IDENTITY` 하드코드 기본값 + `loadBotIdentity()` 시작 및 6시간 리로드 (LLM 없이 작동)

**커밋:** `010b944`, `bd155de`, `8ab4686`, `1b2e1e7`, `24702f5`

---

## 2026-03-04 (세션 2)
### ✅ 제이 중심 지휘 체계 구축 — 완료

**완료 항목:**
- 제이 LLM Groq → Gemini 2.5 Flash 교체 (`intent-parser.js`, `token-tracker.js`)
- 제이 OpenClaw 에이전트 전환 — IDENTITY/MEMORY/TOOLS/HEARTBEAT.md 전면 교체
- mainbot.js Telegram 폴링 제거 (알람 큐 처리 전용화)
- bot_commands 테이블 추가 (DB 마이그레이션 v4)
- 스카 커맨더 (`ska.js`) 신설 — `ai.ska.commander` launchd 등록
- 루나 커맨더 (`luna-commander.cjs`) 신설 — `ai.investment.commander` launchd 등록
- 클로드 커맨더 (`claude-commander.js`) 신설 — `ai.claude.commander` launchd 등록
- intent-parser.js: ska_query/ska_action/luna_query/luna_action/claude_action 인텐트 추가
- router.js: 각 팀 bot_commands 연동 핸들러 추가
- crypto.js: 거래 일시정지 플래그(luna-paused.flag) 체크 추가

**현재 지휘 체계:**
```
사장님(텔레그램) → 제이(OpenClaw) → bot_commands → 스카/루나/클로드 커맨더
                                  ← mainbot_queue ← 팀봇 알람
```

---

### ✨ 제이 중심 지휘 체계 + 루나팀 고도화
- 제이 OpenClaw 에이전트 전환
- mainbot.js Telegram 폴링 제거
- bot_commands 테이블 추가(v4)
- 스카 커맨더 신설(ai.ska.commander)
- 루나 커맨더 신설(ai.investment.commander)
- 클로드 커맨더 신설(ai.claude.commander)
- intent-parser 스카/루나/클로드 인텐트 추가
- router.js 팀장 명령 연동
- luna.js 아르고스 전략 컨텍스트 연결
- luna.js asset_snapshot 자동 기록
- nemesis.js 포지션 한도 불일치 수정
<!-- session-close:2026-03-04:제이-중심-지휘-체계-루나팀-고도화 -->

### ✨ 팀 기능 문서화 및 제이 NLP 고도화
- TEAMS.md 문서 작성
- 키워드 패턴 14→24개 확장
- Gemini 프롬프트 전면 개편
- /dexter·/archer 실제 실행 전환
- 루나팀 OpenAI gpt-4o 라우팅
- LLM 속도테스트 모델 목록 갱신
- OpenAI 키 갱신 및 o-시리즈 파라미터 수정
<!-- session-close:2026-03-04:팀-기능-문서화-및-제이-nlp-고도화 -->

### ✨ 제이↔클로드 통신·NLP자동개선·정체성유지시스템
- 제이↔클로드 직접 통신 채널 (ask_claude)
- NLP 자동개선 루프 (analyze_unknown → nlp-learnings.json)
- 팀장·팀원 정체성 주기적 점검 및 자동 학습
- 각 커맨더 LLM 없이 파일 기반 정체성 능동 유지
- LLM 명칭 일반화 (Gemini → LLM_FALLBACK)
<!-- session-close:2026-03-04:제이클로드-통신nlp자동개선정체성유지시스템 -->

## 2026-03-04 (세션 1)
### 🔄 루나팀 Phase 3 고도화 — 미완료 상태로 중단

**이전 세션(2026-03-03 심야)에서 작업된 내용 (미커밋 상태):**
- `bots/investment/shared/signal.js`: PAPER_MODE 통합 + 자산 보호 5원칙 (`checkSafetyGates`)
- `bots/investment/shared/db.js`: strategy_pool + risk_log + asset_snapshot 테이블 추가
- `bots/investment/team/luna.js`: 2라운드 토론 구조 (`runDebateRound`)
- `bots/investment/team/nemesis.js`: 보수화 프롬프트 + traceId + NEMESIS_SYSTEM 교체
- `bots/investment/team/argos.js`: 외부 전략 수집봇 구현 (Reddit r/algotrading + r/CryptoCurrency + r/stocks)

**남은 작업 (다음 세션에서 이어서):**
- TASK 4: `bots/investment/launchd/ai.investment.argos.plist` 생성 (6시간 주기)
- TASK 5: `aria.js` 장 시간 체크 — `analyzeKisMTF`/`analyzeKisOverseasMTF`에 장 시간 외 처리 추가
  - `isKisMarketOpen`, `isKisOverseasMarketOpen`은 이미 `shared/secrets.js`에 있음
  - `domestic.js`/`overseas.js`에서 이미 사용 중 → aria.js 내부에 추가는 이중체크 or 다른 의미일 수 있음
- TASK 7: launchd plist (argos + 기타 누락분)
- TASK 8: cost-tracker 텔레그램 리포트 함수 추가
- TASK 9: chronos.js ESM 전환 (현재 CommonJS `require` 사용)
- 전체 커밋

<!-- session-interrupted:2026-03-04:루나팀-phase3-고도화-미완료-중단 -->

### ⚙️ Phase 3 OPS 전환 + 투자 리포트 + 메모리 정리
- DuckDB WAL 버그 수정 (CHECKPOINT)
- E2E 테스트 전체 통과 (crypto/domestic/overseas)
- 암호화폐 PAPER_MODE=false OPS 전환
- LLM 정책 v2.2 Groq 전용
- reporter.js 투자 리포트 시스템
- MEMORY.md 350→179줄 압축
<!-- session-close:2026-03-04:phase-3-ops-전환-투자-리포트-메모리-정리 -->

### ✨ 메인봇(오케스트레이터) 구현 완료
- DB 마이그레이션(token_usage 포함)
- mainbot.js/router/filter/dashboard 구현
- 팀별 publishToMainBot 클라이언트(CJS/ESM)
- time-mode.js
- naver-monitor/signal/dexter 교체
- launchd plist
- docs/MAINBOT.md
<!-- session-close:2026-03-04:메인봇오케스트레이터-구현-완료 -->

### ♻️ 전체 봇 sendTelegram → publishToMainBot 전면 교체
- error-tracker.js 마지막 교체 완료
- dexter 체크섬 갱신 (9개 파일)
<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai -->

### ✨ 메인봇 문서화 + time-mode 연동 + 전체 sendTelegram 교체 완료
- MAINBOT.md 최신화
- team-features.md 메인봇 OPS 상태 반영
- MEMORY.md 시스템 상태 업데이트
- time-mode.js crypto.js 연동
- manual scripts 교체 (pickko-revenue-confirm, e2e-test)
<!-- session-close:2026-03-04:메인봇-문서화-timemode-연동-전체-sendtel -->

### ✨ API 문서 분석 기반 개선사항 적용
- parse_mode HTML 추가 (telegram.js + mainbot.js)
- 4096자 메시지 분할 로직 (mainbot.js)
- LLM_DOCS.md 업데이트 (Telegram 9.5 + Groq 신모델 + OpenClaw + Claude 자동 캐싱)
<!-- session-close:2026-03-04:api-문서-분석-기반-개선사항-적용 -->

### ✨ LLM키통합+알람버그수정+덱스터패턴학습
- packages/core/lib/llm-keys.js 공용 LLM 키 로더
- mainbot_queue 무한반복 알람 버그 수정
- 덱스터 mainbot_queue 건강 체크 추가
- 덱스터 오류 패턴 학습 시스템 (dexter_error_log)
<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습 -->

## 2026-03-03
### ✨ 루나팀 OPS 전환 + 실행 체인 버그 수정
- **네이버 뉴스 API 등록**: 헤르메스 국내주식 뉴스 수집 활성화 (25,000 call/day)
  - config.yaml `news.naver_client_id/secret` 설정, 10건 뉴스 수집 확인
- **덱스터 DuckDB 읽기전용 수정**: database.js 체크 스크립트에 `READ_ONLY` 모드 추가
  - ai.invest.pipeline 실행 중 DuckDB 락 충돌 해소
- **루나팀 전체 테스트**: crypto/domestic/overseas 3사이클 전 통과
- **크립토 OPS 전환**: `ai.investment.crypto` PAPER_MODE=true → false (2026-03-03)
  - launchd plist 수정 + 재로드, `🔴 PAPER_MODE=false` LIVE 모드 확인
- **시그널 실행 체인 버그 수정** (커밋 `9390f7e`):
  - Bug 1: 헤파이스토스가 `getPendingSignals` 사용 → 네메시스 승인 후 `approved` 조회 안됨
    → `getApprovedSignals()` 추가, 헤파이스토스 전환
  - Bug 2: 네메시스 조정 금액($100)이 DB에 미반영 → 헤파이스토스가 원본 $2000 사용
    → `updateSignalAmount()` 추가, 네메시스에서 승인 시 호출
- **ETH → USDT 전환**: 바이낸스 ETH 0.0681 전량 매도 → $138.10 USDT 확보 (avg $2,028.94)
  - 크립토 봇 실거래 자금 확보 ($100 BUY 주문 가능)
<!-- session-close:2026-03-03:루나팀-ops전환-실행체인버그수정 -->

### ✨ 스카팀 운영관리 고도화 v3.0
- **Phase A: 폴더 구조 개편** — bots/reservation/src/ 27개 파일 → auto/manual 계층 구조 재편 (git mv)
  - auto/monitors/: naver-monitor(앤디), pickko-kiosk-monitor(지미) + 래퍼 sh
  - auto/scheduled/: daily-summary/audit/pay-scan + 래퍼 sh
  - manual/reservation/: pickko-accurate/cancel/register/query
  - manual/admin/: pickko-member/ticket/verify
  - manual/reports/: occupancy/alerts/stats/revenue/pay-pending
  - src/ 잔류: 진단·테스트 9개 파일
  - launchd plist 8개 경로 업데이트 + 재로드 (exit 127 전부 해소)
- **Phase B: 에이전트 통신 구축** — lib/state-bus.js + migrations/003_agent_state.js
  - agent_state 테이블: 에이전트 상태 공유 (idle/running/error)
  - pickko_lock 테이블: 픽코 어드민 단독접근 뮤텍스 (TTL 5분)
  - pending_blocks 테이블: 앤디→지미 블록 요청 큐
  - 앤디: 사이클 시작→running, 완료→idle, 오류→error 전환
  - 지미: acquirePickkoLock + finally 블록에서 idle 전환 + 락 해제
  - 수동(pickko-accurate): acquirePickkoLock('manual') + process.once('exit') 자동 해제
- **Phase C: 덱스터 ska 감시** — bots/claude/lib/checks/ska.js (5개 체크)
  - DB 존재, agent staleness(10분warn/30분error), pickko 데드락, 큐 적체, 앤디 마지막 성공
  - dexter.js: bots→ska→logs 순서로 등록
- **버그 수정**: state-bus updateAgentState 파라미터 순서 오류 (last_success_at↔last_error 뒤바뀜)
- **버그 수정**: pickko-kiosk-monitor 조기리턴 경로에서 jimmy 'running' 잔존 → finally 블록으로 이동
- 테스트: 폴더구조/state-bus(9케이스)/kiosk-monitor DEV 실행/덱스터 ska 전체 통과
- 루나팀 + 스카팀 launchd 정지 → 테스트 → 재시작
<!-- session-close:2026-03-03:스카팀-고도화-v3.0 -->

### ✨ 클로드팀 고도화 v2.0 (커밋 `3956782`)
- **Axis 1 — 덱스터↔아처 팀 통신 버스**:
  - `migrations/001_team_bus.js`: `~/.openclaw/workspace/claude-team.db` 스키마 (4테이블)
    - `agent_state`: 에이전트 상태 공유 (idle/running/error), `messages`: 에이전트 간 메시지 큐
    - `tech_digest`: 아처 기술 소화 이력, `check_history`: 덱스터 체크 실행 이력
  - `lib/team-bus.js`: 에이전트 상태·메시지큐·기술소화이력·체크이력 API
  - `scripts/migrate.js`: DB 마이그레이션 러너
  - `scripts/team-status.js`: 팀 상태 대시보드 콘솔 (`npm run status`)
  - `src/dexter.js`: team-bus 연동 — 시작/체크이력/완료 상태 자동 기록
- **Axis 2 — 아처 역할 재정의 (AI/LLM 트렌드 + 패치업 오케스트레이터)**:
  - `lib/archer/config.js`: MARKET 제거, WEB_SOURCES 추가 (Anthropic뉴스/OpenAI/HuggingFace/arXiv/The Batch), GitHub 12개·npm 7개
  - `lib/archer/fetcher.js`: 시장/봇 함수 제거, `fetchWebSource(RSS)` + `runNpmAudit` 추가
  - `lib/archer/analyzer.js`: buildContext 재작성, SYSTEM_PROMPT AI/LLM 패치 집중 (patches/security/llm_api/ai_techniques/web_highlights)
  - `lib/archer/patcher.js` (신규): `savePatchTickets` + `savePatchRequest(PATCH_REQUEST.md)` + `sendTelegram`
  - `lib/archer/reporter.js`: market/bots 섹션 제거, patch/audit/llm_api/ai_techniques/web_highlights 추가
  - `src/archer.js`: team-bus + patcher 연동
  - `scripts/patch-status.js` (신규): 패치 현황 콘솔 (`npm run patch:status`)
- **인프라**:
  - `package.json`: 11개 scripts (dexter:fix/daily + archer/archer:telegram/fetch-only + migrate/status/patch:status)
  - `CLAUDE.md` (신규): PATCH_REQUEST.md 처리 규칙 + 팀버스 섹션 (세션 시작 시 자동 로드)
  - `bots/registry.json`: archer dataSources v2.0 업데이트
- **검증**: 마이그레이션 ✅ / team-bus CRUD ✅ / 덱스터+team-bus ✅ / 아처 --fetch-only ✅ (GitHub 12개·npm 7개·웹소스 5개·audit 5건)
<!-- session-close:2026-03-03:클로드팀-고도화-v2.0 -->

## 2026-03-02
### ✨ Phase 3 E2E 테스트 + 아리아 안정성 개선
- 루나팀 Phase 3 전 사이클 E2E 테스트 완료: crypto(8.4초) / domestic(4.3초) / overseas(5.9초)
- 바이낸스 fetchOHLCV 재시도 로직: 일시 API 장애 대응 (1s·2s 지수 백오프, max 2회 재시도)
- BB 판정 버퍼존 도입: 절대값 비교 → 범위 비율(0~1) 기준 상단 95%↑/하단 5%↓ 임계값
  - 005930 삼성전자 BB 99% 위치 → 신뢰도 0%→20% 개선 (점수 0.00→-1.00)
- 덱스터 bots.js: `ai.investment.crypto/domestic/overseas` 3개 서비스 모니터링 추가
- registry.json: `investment` 항목 신규 등록 — Phase 3-A/B 팀원 12명 + 마켓 3종
<!-- session-close:2026-03-02:phase3-e2e-테스트-아리아-안정성-개선 -->

### ✨ Phase 3-B 국내외주식 사이클 구현 완료
- aria.js: Yahoo Finance OHLCV + analyzeKisMTF(일봉65%/1h35%) + analyzeKisOverseasMTF(일봉60%/1h40%)
- domestic.js: 국내주식 30분 사이클 (아리아·헤르메스·소피아·루나·한울 파이프라인 완성)
- overseas.js: 미국주식 30분 사이클 (동일 파이프라인, kis_overseas exchange)
- cost.daily→cost.usage 버그 수정 (crypto.js·domestic.js·overseas.js 3개)
- launchd: ai.investment.domestic + ai.investment.overseas 등록 (5분 주기, PAPER_MODE=true)
- 테스트: domestic --force (삼성전자·SK하이닉스) 5.3초 완료 / overseas --force (AAPL·NVDA) 5.1초 완료
<!-- session-close:2026-03-02:phase3b-국내외주식-사이클-구현-완료 -->


### ✨ SKA-P05~P08 루나팀 패턴 적용 + deploy-ops.sh
- lib/error-tracker.js 연속 오류 카운터 (naver-monitor+kiosk-monitor 통합)
- scripts/e2e-test.js E2E 통합 테스트 28/28
- lib/mode.js DEV/OPS 모드 분리 (MODE=ops, getModeSuffix)
- lib/status.js 프로세스 상태 파일 /tmp/ska-status.json
- scripts/deploy-ops.sh E2E→컨펌→OPS재시작→체크섬→텔레그램
<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss -->

### ✨ 3중 가동/중지 lib/health.js + deploy-ops.sh
- lib/health.js 3중 가동(preflightSystemCheck/ConnCheck)+3중 중지(shutdownDB/Cleanup/registerShutdownHandlers)
- scripts/preflight.js health.js 래퍼로 교체
- src/start-ops.sh 3중 체크 추가(--conn)
- src/naver-monitor.js registerShutdownHandlers+isShuttingDown 루프 가드
- scripts/e2e-test.js 32/32 통과
<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss -->

### ✨ 하트비트 오늘예약현황 추가 + scar→ska 정리 + 절대규칙 등록
- getTodayStats() DB함수 추가 (네이버+키오스크 합계)
- 하트비트 메시지 오늘 예약현황 섹션 추가
- etl.py scar.duckdb→ska.duckdb 주석 수정
- 이브(Eve) 절대규칙 스카팀 등록 + registry.json 추가
- 절대규칙 기본언어 한국어 추가
<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙 -->

### ✨ OpenClaw 공식문서 검토 + 속도테스트 프로바이더 등록 + LLM_DOCS Cerebras/SambaNova 추가
- 루나팀 분석가 프로바이더 분산(onchain→cerebras, sentiment→sambanova)
- 루나팀 LLM 후보군 등록(llm-candidates.json + speed-test --luna)
- OpenClaw 공식문서 검토 및 개선 항목 분류
- LLM_DOCS.md Cerebras/SambaNova 섹션 추가(§4·§5)
- 즉시 조치 3개(NVM path 수정·보안감사·세션정리)
- 속도테스트기 5개 프로바이더 추가(xai/mistral/together/fireworks/deepinfra)
- improvement-ideas.md OpenClaw 개선 백로그(OC-001~009) 추가
<!-- session-close:2026-03-02:openclaw-공식문서-검토-속도테스트-프로바이더-등 -->

### ✨ OpenClaw OC-001~009 보안·설정 개선 전체 완료
- OC-001 qwen CRITICAL 제거(fallbacks에서 제거)
- OC-002 denyCommands 무효 6개→canvas.eval 교체
- OC-003 botToken→tokenFile 파일 분리(chmod 600)
- OC-004 ackReaction 👀 활성화(scope:all + removeAckAfterReply)
- OC-005 session.reset daily 새벽3시
- OC-006 session.dmScope per-channel-peer
- OC-007 멀티에이전트 스킵(루나팀 standalone)
- OC-008 include분리 스킵(불필요)
- OC-009 configured,missing 3개 모델 제거
<!-- session-close:2026-03-02:openclaw-oc001009-보안설정-개선-전체-완 -->

### ✨ 루나팀 다중심볼+KIS통합강화
- 절대규칙 업데이트(루나팀=암호화폐·국내외주식)
- LU-020 다중심볼 BTC/ETH/SOL/BNB getSymbols()
- LU-021 KIS 6지표 풀분석(이평정배열/스토캐스틱/ATR/거래량)
- isKisMarketOpen() 장중필터(09:00~15:30 KST)
- signal-aggregator 코인+KIS 통합 파이프라인
<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화 -->

### ✨ registry.json 현황 업데이트 + KIS Yahoo폴백
- registry.json 루나팀 실제 상태 반영(온체인·뉴스·감성 dev로 정정)
- registry.json 제이슨 파이프라인 상세 명시(6지표·3TF·4심볼)
- registry.json model/logFile/launchd 실제값 반영
- KIS fetchOHLCV Yahoo Finance 폴백(150개 이력, MACD·MA60·MA120 활성화)
<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo -->

### ✨ LU-035리서처+LU-024리포터+ETH실매수
- LU-035 강세/약세 리서처 signal-aggregator 통합 완성
- LU-022/024 성과 리포트 reporter.js 구현 (일/주/월, launchd 22:00)
- ETH/USDT 0.0682 실거래 매수 (.25)
- 맥북 개발 방침 확정 + 개발 우선순위 재조정 문서 반영
<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수 -->

### ✨ 취소 감지 교차검증 + KIS 구현 + LLM 비용 최적화
- naver-monitor.js 취소 감지 교차검증: 감지 2 먼저 실행 → currentCancelledList → 감지 1 교차검증 (이용완료 오탐 방지)
- KIS lib/kis.js qty<1 버그 수정 (dryRun 분기 앞으로 이동)
- fund-manager.js: sonnet-4-6 → haiku-4-5-20251001, max_tokens 2048→1024, timeout 30s→20s
- signal-aggregator.js: MAX_DEBATE_SYMBOLS=2 추가 (debate 최대 2심볼/실행, API 비용 절감)
- launchd 스케줄 최적화: ai.invest.dev 5분→10분, ai.invest.fund 30분→60분
- SYSTEM_DESIGN.md + work-history.md 전체 업데이트
<!-- session-close:2026-03-02:취소감지교차검증-kis구현-llm비용최적화 -->

### ✨ LU-030펀드매니저+LU-036리스크매니저v2
- LU-030 fund-manager.js — sonnet-4-6 포트폴리오 오케스트레이터 (30분 launchd)
- LU-036 risk-manager.js v2 — ATR변동성·상관관계·시간대·LLM haiku 4단계 조정
- registry.json 펀드매니저·리포터 서브봇 등록
<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2 -->

### ✨ LU-037-백테스팅엔진
- LU-037 scripts/backtest.js — TA전략 역사적 검증 엔진
- 4개 심볼 1d/4h 백테스트 + 텔레그램 발송
- 인사이트: SOL/BNB 수익팩터 2.0 수준 / BTC/ETH 하락장 TA진입 취약
<!-- session-close:2026-03-02:lu037백테스팅엔진 -->

### ✨ LU-038 몰리 v2 TP/SL 모니터 구현 완료
- upbit-bridge.js에 checkTpSl() 함수 추가 (진입가±3% 자동 청산)
- ai.invest.tpsl launchd 등록 (5분 주기 DRY_RUN)
- marketSell + db 연동 + 텔레그램 알림
- 드라이런 테스트 통과 (BTC/USDT -2.03% SL 조건 미달 정상)
<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료 -->

### ✨ CL-004 Dev/OPS 분리 구현 완료
- mode.js getModeSuffix() 추가 (DEV:-dev / OPS:'')
- health.js STATUS_FILE 동적화 (/tmp/invest-status-dev.json vs invest-status.json)
- dexter bots.js 루나팀 5개 서비스 + DEV/OPS 상태 분리 체크
- switch-to-ops.sh 전환 체크리스트 스크립트 신규
- dry_run=false 위험 감지 → true 복구
<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료 -->

### ✨ 아처-리포트-봇팀-현황-섹션-추가
- fetcher.js fetchLunaStats+fetchSkaStats 추가
- reporter.js 루나팀/스카팀 섹션 추가
- analyzer.js buildContext 봇 데이터 통합
- 덱스터 체크섬 갱신
<!-- session-close:2026-03-02:아처리포트봇팀현황섹션추가 -->

### ✨ 대리등록-네이버-예약불가-자동처리-로직-추가
- pickko-kiosk-monitor.js blockSlotOnly() + --block-slot 모드 추가
- pickko-register.js 픽코 등록 성공 후 네이버 차단 자동 호출
- 오수정님 테스트 통과 (이미 차단됨 감지)
<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가 -->

### ✨ 오늘-예약-검증-audit-today-구현
- auditToday() 함수 추가 (pickko-kiosk-monitor.js)
- getKioskBlocksForDate(date) DB 함수 추가 (lib/db.js)
- --audit-today 진입점 추가
- run-today-audit.sh 래퍼 스크립트 생성
- ai.ska.today-audit.plist 08:30 KST launchd 등록
<!-- session-close:2026-03-02:오늘예약검증audittoday구현 -->

### 🔧 auditToday-failedList-차단실패-알림-추가
- blockNaverSlot false반환시 DB false positive 방지 확인
- auditToday failedList 추가 - 차단실패 텔레그램 알림
- 덱스터 체크섬 갱신
<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가 -->

### 🔧 blockNaverSlot-avail소멸-보조확인-차단성공
- verifyBlockInGrid suspended만 확인하는 한계 발견
- blockNaverSlot avail 소멸 보조 확인 추가 (예약가능설정 방식 차단 지원)
- B룸 18:00 차단 성공 확인
<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공 -->

### ✨ audit-date-내일날짜-검증-완료
- auditToday dateOverride 파라미터 추가
- --audit-date=YYYY-MM-DD CLI 옵션 추가
- 내일(03/03) 고아차단 해제 흐름 검증 완료
<!-- session-close:2026-03-02:auditdate내일날짜검증완료 -->

### ✨ 픽코취소-네이버해제-자동화-unblock-slot
- unblockNaverSlot avail-gone 버그 수정 (false positive return 제거)
- restoreAvailGoneSlot 헬퍼 추가 (B룸 예약가능설정방식 복구)
- unblockSlotOnly + --unblock-slot CLI 모드 추가
- pickko-cancel-cmd.js: 픽코취소→네이버해제 자동 2단계 실행
<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot -->

### 🔧 취소-테스트-성공-avail-gone-복구-확인
- 이승호 B룸 18:00 취소 테스트 성공 (픽코취소+네이버해제)
- avail-gone 방식 복구 확인 (restoreAvailGoneSlot 정상 작동)
<!-- session-close:2026-03-02:취소테스트성공availgone복구확인 -->

### ✨ 예약 취소 E2E 완성 + TOOLS.md 취소/등록 도구 정비
- pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제) 완성
- avail-gone 방식 unblockNaverSlot 수정 + restoreAvailGoneSlot 구현
- --block-slot --unblock-slot --audit-date CLI 추가
- TOOLS.md 취소 섹션 추가 + pickko-accurate.js 내부모듈 명시
- 취소+등록 E2E 스카봇 자연어 테스트 통과
<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정 -->

### ♻️ 봇 이름 변수화 완료
- dexter.js/reporter.js/autofix.js BOT_NAME='덱스터' 상수 추가
- archer.js/archer/reporter.js BOT_NAME='아처' 상수 추가
- kis-executor.js BOT_NAME='크리스' 상수 추가
- 덱스터 체크섬 갱신 9개 파일
<!-- session-close:2026-03-02:봇-이름-변수화-완료 -->

### ✨ 루나팀 Phase 3-A v2.1 — bots/investment/ 신규 아키텍처 구현
- **bots/investment/ 디렉토리 전체 신규 생성** (ESM "type":"module")
- shared/ 5개 모듈: llm-client.js(통합LLM) + db.js(DuckDB) + signal.js + secrets.js(config.yaml) + report.js + cost-tracker.js
- team/ 9개 에이전트: aria(MTF TA) + oracle(온체인) + hermes(뉴스) + sophia(감성+xAI) + zeus(강세) + athena(약세) + nemesis(리스크) + luna(오케스트레이터) + hephaestos(바이낸스) + hanul(KIS)
- markets/ 3개 사이클: crypto.js(30분 throttle+BTC±3% 긴급트리거) + domestic.js(스켈레톤) + overseas.js(스켈레톤)
- **callLLM(agentName, system, user, maxTokens)** 통합 — PAPER_MODE=true→전원 Groq Scout, LIVE→luna+nemesis Haiku 4.5
- config.yaml 도입 (secrets.json 폴백), cost-tracker.js BUDGET_EXCEEDED EventEmitter
- npm 의존성: @anthropic-ai/sdk + groq-sdk + ccxt + js-yaml + axios (36 packages)
- node --check 20개 파일 전체 통과
- launchd ai.investment.crypto: 5분 주기(내부 30분 스로틀), BTC 긴급 트리거
<!-- session-close:2026-03-02:루나팀-phase3a-v21-bots-investment-신규아키텍처 -->

## 2026-03-01
### 🔧 새로고침 버튼 fix + 알림 컨텍스트 공유
- naver-monitor 새로고침 버튼 ElementHandle.click→evaluate() 수정
- pickko-alerts-query.js 신규 (알림 DB 조회 CLI)
- CLAUDE_NOTES.md 알림 인식 규칙 추가 (방금 알림 키워드 트리거)
- deployer.js BOOT.md 생성 시 최근 48시간 에러 알림 자동 인라인
<!-- session-close:2026-03-01:새로고침-버튼-fix-알림-컨텍스트-공유 -->

### 🔧 ETL actual_revenue 입금 기준 전환 + pickko_total 분석
- ETL actual_revenue: pickko_total(이용일) → total_amount(입금일) 기준 전환
- studyroom_revenue = total_amount - general_revenue 로 재계산
- DuckDB 02/28 수동 수정 (236,000→319,500)
- ETL 즉시 재실행 — 91건 upsert, 02/27·02/28 정상화
<!-- session-close:2026-03-01:etl-actual_revenue-입금-기준-전환-pi -->

### 🔧 BOOT 침묵 규칙 통일 + ETL total_amount 기준 변경
- BOOT.md 메시지 전송 규칙 제거(침묵 대기로 통일)
- ETL actual_revenue를 total_amount 기준으로 변경
- DuckDB 02/28 actual_revenue 수동 수정(319,500)
- naver-monitor 새로고침 버튼 click 타임아웃 수정
- pickko-alerts-query.js 신규 생성
- deployer.js BOOT 에러 알림 인라인 추가
<!-- session-close:2026-03-01:boot-침묵-규칙-통일-etl-total_amount -->

### 🔧 미컨펌 알림 날짜 버그 수정
- 미컨펌 알림 범위 최근 3일 이내로 제한
- 메시지 '어제 매출이' → 실제 날짜(prevHeader) 표시로 수정
<!-- session-close:2026-03-01:미컨펌-알림-날짜-버그-수정 -->

### ⚙️ 예약 오류 체크 - 픽코 CDP 타임아웃 원인 분석
- 픽코 예약 실패 원인 확인 (Runtime.callFunctionOn timed out)
- 픽코 서버 일시 지연 → 재시도 로직 정상 작동 확인
- 3건 모두 최종 픽코 등록 성공 확인 (verified)
<!-- session-close:2026-03-01:예약-오류-체크-픽코-cdp-타임아웃-원인-분석 -->

### ⚙️ 스카 재시작 및 부팅 확인
- 스카 재시작 (PID 66467)
- 부팅 완료 확인 (5.2초, isError=false)
<!-- session-close:2026-03-01:스카-재시작-및-부팅-확인 -->

### ✨ 투자팀봇 Phase1 구현 및 검증
- bots/invest 전체 구현 (20파일)
- DuckDB 스키마 4테이블
- CCXT 바이낸스/업비트 드라이런
- TA분석가 RSI/MACD/BB
- 신호집계기 Claude API 연동
- 리스크매니저 4규칙
- 실행봇+업비트브릿지
- launchd 2개 등록
- dry-run-test 전체 통과
<!-- session-close:2026-03-01:투자팀봇-phase1-구현-및-검증 -->

### ✨ 투자봇 DEV/OPS 분리 + 3중 체크 시스템
- lib/mode.js DEV/OPS 모드 분리
- lib/health.js 3중 체크 시스템
- start-invest-ops.sh 시작 3중(Shell+Node+API)
- start-invest-bridge.sh 브릿지 3중 체크
- scripts/health-check.js 상태 조회 CLI
- graceful shutdown SIGTERM/SIGINT 핸들러
<!-- session-close:2026-03-01:투자봇-devops-분리-3중-체크-시스템 -->

### ✨ 덱스터 구현 완료 + 일일보고 + 픽스 로그
- 덱스터(Dexter) 클로드팀 점검봇 구현 (8개 체크 모듈)
- 자동수정 (stale lock, chmod 600, 로그로테이션)
- 버그레포트 자동 등록
- --update-checksums 체크섬 베이스라인 갱신
- 일일보고 (--daily-report) + launchd 08:00 KST
- 자동 픽스 이력 기록 (dexter-fixes.json)
- npm install + npm audit fix
- .gitignore *.db 추가
<!-- session-close:2026-03-01:덱스터-구현-완료-일일보고-픽스-로그 -->

### ✨ 아처(Archer) 기술 인텔리전스 봇 구현 완료
- lib/archer/config.js
- lib/archer/store.js
- lib/archer/fetcher.js
- lib/archer/analyzer.js
- lib/archer/reporter.js
- src/archer.js
- launchd ai.claude.archer
- registry.json 아처 등록
- CLAUDE_NOTES.md 아처 섹션 추가
<!-- session-close:2026-03-01:아처archer-기술-인텔리전스-봇-구현-완료 -->

### ✨ KIS 국내주식 실행봇 크리스 구현
- lib/kis.js KIS Open API 클라이언트 신규 (토큰캐시·OHLCV·매수매도·잔고)
- src/kis-executor.js 크리스 봇 신규 (인라인 리스크·드라이런·모의투자)
- lib/db.js Migration v2 exchange 컬럼 추가 + 함수 파라미터 확장
- signal-aggregator.js KIS 파이프라인 + KIS 전용 LLM 프롬프트
- lib/secrets.js isKisPaper/getKisAccount/hasKisApiKey/getKisSymbols 추가
- bots/registry.json 크리스 봇 등록
<!-- session-close:2026-03-01:kis-국내주식-실행봇-크리스-구현 -->

### ✨ 스카팀 루나팀 패턴 적용 ①②③
- DB Migration System (scripts/migrate.js + migrations/)
- Secrets Fallback Strategy (lib/secrets.js + lib/telegram.js)
- Start Script Validation (scripts/preflight.js + start-ops.sh 2중 체크)
<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용 -->

### ✨ KIS 실전+모의투자 키 이중화 + API 연결 검증
- secrets.json: kis_paper_app_key/secret 분리 저장
- lib/secrets.js: getKisAppKey()/getKisAppSecret() 모드 자동 분기
- lib/kis.js: 토큰 캐시 경로 분리 + VTS TLS 우회 + OHLCV output 키 수정 + 날짜 범위 수정
- 텔레그램 토큰 동기화
- 드라이런 E2E 검증 완료
<!-- session-close:2026-03-01:kis-실전모의투자-키-이중화-api-연결-검증 -->

### ✨ KIS API 연동 완료 및 파이프라인 활성화
- VTS 포트 29443 수정 (기존 9443 오류)
- 잔고 조회 성공 (모의투자 3천만원 확인)
- KIS 파이프라인 signal-aggregator 활성화
- notifyKisSignal·notifyKisTrade 추가 (원화 포맷)
- kis-executor.js notifyKisTrade 교체
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->

### 🔧 포캐스트 0원 버그 수정 (공휴일 Prophet 과보정)
- forecast.py yhat≤0 폴백 (yhat_upper*0.5 + confidence=0.15)
- 삼일절·대체공휴일 Prophet 음수 예측 원인 파악
- 3/2 예측 0원→18821원 DB 업데이트
- ETL 정상 확인 (3/1 최종 212800원)
<!-- session-close:2026-03-01:포캐스트-0원-버그-수정-공휴일-prophet-과보정 -->

## 2026-02-28
### ⚙️ pickko-daily-audit 스케줄 22:00 원복
- pickko-daily-audit 23:50→22:00 원복 (plist 수정 + launchd 재등록)
<!-- session-close:2026-02-28:pickkodailyaudit-스케줄-2200-원복 -->

### ⚙️ OpenClaw v2026.2.26 업데이트 및 재시작
- openclaw gateway restart (완전 중지 후 재시작)
- openclaw v2026.2.19-2 → v2026.2.26 업데이트
- 텔레그램 업데이트 완료 알림 전송
<!-- session-close:2026-02-28:openclaw-v2026226-업데이트-및-재시작 -->

### ⚙️ 스카 재부팅
- openclaw gateway restart → 스카 부팅 완료 (durationMs=59s)
<!-- session-close:2026-02-28:스카-재부팅 -->

### 🔧 매출 보고 일반이용 합산 수정
- pickko-daily-summary.js: 23:50 자동 보고 합계에 일반이용(스터디카페) 포함
- pickko-stats-cmd.js: 일별/기간별 조회 합계에 일반이용 포함
- pickko-revenue-confirm.js: 매출 확정 메시지 합계에 일반이용 포함
- CLAUDE_NOTES.md: 매출 보고 시 일반이용 포함 규칙 추가
<!-- session-close:2026-02-28:매출-보고-일반이용-합산-수정 -->

### 🔧 미해결 알림 해제 + 매출 일반이용 합산 수정
- 픽코 취소 실패 알림 수동 resolved 처리 (2026-02-27 18:00 A2)
- naver-monitor 재시작 후 미해결 알림 반복 전송 중단 확인
- pickko-daily-summary.js 일반이용 합계 포함 수정
- pickko-stats-cmd.js 일반이용 합계 포함 수정
- pickko-revenue-confirm.js 일반이용 합계 포함 수정
- CLAUDE_NOTES.md 매출 보고 규칙 추가
<!-- session-close:2026-02-28:미해결-알림-해제-매출-일반이용-합산-수정 -->

### 🔧 고아 프로세스 자동 정리 추가
- start-ops.sh cleanup_old()에 고아 tail -f 프로세스 자동 정리 추가 (2시간 재시작마다 실행)
<!-- session-close:2026-02-28:고아-프로세스-자동-정리-추가 -->

### 🔧 Runtime.callFunctionOn 타임아웃 근본 수정 + DB 중복 레코드 정리
- pickko-accurate.js page.click→evaluate (회원선택 버튼)
- pickko-verify.js page.click→evaluate (검색 버튼)
- start-ops.sh PICKKO_PROTOCOL_TIMEOUT_MS=300000 추가
- DB 중복 레코드 정리 (010-2187-5073 03-14 failed)
<!-- session-close:2026-02-28:runtimecallfunctionon-타임아웃-근본- -->

### 🔧 23:50 generalRevenue 미수집 + 중복예약 표시 버그 수정
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
<!-- session-close:2026-02-28:2350-generalrevenue-미수집-중복예약-표 -->

### 🔧 CL-006 코딩가이드 리팩토링 완료 확인 + 백필 스크립트
- CL-006 플랜 전항목 완료 확인 (P0~P4 모두 이전 세션에서 구현됨)
- backfill-study-room.js 36건 업데이트 완료 (이전 세션 작업)
- pickko-daily-summary isMidnight 23:50 버그 수정 확인
<!-- session-close:2026-02-28:cl006-코딩가이드-리팩토링-완료-확인-백필-스크립트 -->

## 2026-02-27

### 인프라 & 문서
- **시스템 설계 v2.0** — SYSTEM_DESIGN.md 전면 개정 (봇별 LLM 확정, 투자팀 3봇, 메모리 할당표)
- **README.md** — 10봇 전체 아키텍처 다이어그램 추가
- **iPad Termius SSH** 설정 완료 (로컬 192.168.45.176 / Tailscale 100.124.124.65)
- **~/.zshrc** alias 등록 (`ska`, `skalog`, `skastatus`)
- OpenClaw 공식 문서 전체 학습 + 투자팀 멀티에이전트 설계
- 2026 LLM·트레이딩봇 커뮤니티 리서치 (`docs/RESEARCH_2026.md`)

### 스카봇 — 기능
- **pickko-ticket.js** `--discount` 플래그: 이용권 전액 할인 (0원 처리), `--reason` 주문 메모
- **findPickkoMember()** → `lib/pickko.js` 공통 함수화 (4개 파일 인라인 코드 통합)
- **완전 백그라운드 모드** — `lib/browser.js` `PICKKO_HEADLESS` 환경변수, `start-ops.sh` `PICKKO_HEADLESS=1`, `ai.ska.naver-monitor.plist` launchd KeepAlive 등록

### 스카봇 — 인프라
- **공유 인프라 구축** — `packages/core` 공유 유틸리티, `packages/playwright-utils`, `bots/_template` 스캐폴딩
- `reservation/lib/cli.js` 추가, 6개 파일 중복 제거

### 스카봇 — 버그 & 안정화
- **BUG-007** 수정 — `protocolTimeout` 30초 + `Promise.race` 8초 타임아웃
- **BOOT 파일명 누출 방지** — `CLAUDE_NOTES.md` BOOT 중 파일명 단독 전송 금지 규칙 추가
- **lib/args.js** 불리언 플래그 지원 (`--key`를 단독 사용 시 true)
- **bug-report.js** 인라인 parseArgs 제거 → `lib/args` 통합

### OpenClaw 최적화
- **BOOT 속도 7분→50초** (8.4× 개선) — `deployer.js` IDENTITY+MEMORY 인라인화, `--sync` 제거, DEV_SUMMARY/HANDOFF BOOT 제외, 7턴→2턴
- **BOOT 54초** 2회 연속 검증 확인 (gemini-2.5-flash)

---

### ♻️ 코딩가이드 목적 재정의 + work-history/coding-guide 세션마감 자동화
- coding-guide.md: 핵심 원칙 섹션 추가, 목적 재정의
- doc-patcher.js: patchWorkHistory + patchCodingGuide 추가
- session-close.js: docsDir 연결
<!-- session-close:2026-02-27:코딩가이드-목적-재정의-workhistorycoding -->

### ♻️ 코딩가이드 Security by Design 전면 적용
- Security by Design 원칙 선언 (어기면 코드가 실행 안 되는 구조)
- lib/secrets.js 강제 검증 패턴 (필수 키 누락 시 즉시 종료)
- pre-commit hook 차단 패턴 (secrets.json git 커밋 자동 차단)
- SafeExchange 클래스 레벨 DEV/OPS 분리 (우회 불가)
- 전체 봇 로그 마스킹·입력 검증·감사 로그 패턴 추가
<!-- session-close:2026-02-27:코딩가이드-security-by-design-전면-적용 -->

### ⚙️ pre-commit 훅 설치 및 공유 인프라 플랜 완료 검증
- scripts/pre-commit 설치 (.git/hooks/ 등록 + chmod +x)
- scripts/setup-hooks.sh 원클릭 설치 스크립트 신규
- packages/core·playwright-utils·_template 플랜 완료 검증 (전 Phase 완료 확인)
<!-- session-close:2026-02-27:precommit-훅-설치-및-공유-인프라-플랜-완료- -->

### ✨ ST-001~003 완료 + ska 설계 + 백로그 전체 등록
- ST-001 state.db 자동 백업 (launchd 03:00 일일)
- ST-002 BUG-006 해결 — deployer.js BOOT 침묵 강화 + telegram.js 파일명 필터
- ST-003 launchd 헬스체크 (10분 주기, 7개 서비스 감시)
- ska 매출예측 시스템 설계 확정 (Prophet + DuckDB, 4개 봇팀)
- 전체 개발 백로그 등록 (ST/FE/MD/LT 20개 항목)
<!-- session-close:2026-02-27:st001003-완료-ska-설계-백로그-전체-등록 -->

### ✨ FE-002 룸별·시간대별 가동률 리포트 구현
- src/occupancy-report.js 신규: 룸별/시간대별 가동률 계산
- 영업시간 09:00~22:00 기준 13슬롯 분석
- --period=week/month --month=YYYY-MM 기간 옵션 지원
- CLAUDE_NOTES.md 가동률 자연어 명령 테이블 추가
<!-- session-close:2026-02-27:fe002-룸별시간대별-가동률-리포트-구현 -->

### ✨ FE-005 로그 rotation (copytruncate, 매일 04:05)
- scripts/log-rotate.js 신규: 10개 로그 copytruncate 방식 로테이션
- ai.ska.log-rotate.plist: 매일 04:05 자동 실행
- 보관 7일, 1KB 미만 스킵, 당일 중복 방지
- health-check.js: 8번째 서비스(log-rotate) 추가
<!-- session-close:2026-02-27:fe005-로그-rotation-copytruncate -->

### ⚙️ FE-006 gemini-2.5-flash execute_tool 누출 버그 재테스트 — 버그 종결
- gemini-2.5-flash telegram run 6건 전수 검사 — execute_tool 텍스트 누출 0건
- 실제 도구 호출(tool=exec) 정상 확인 — 버그 미재현으로 종결
- 부수 발견: sendChatAction 실패 10건 (typing 인디케이터, 메시지 발송 무영향)
<!-- session-close:2026-02-27:fe006-gemini25flash-execute_to -->

### ✨ FE-009 health-check staleness 체크 추가 (naver-monitor 크래시루프 감지)
- health-check.js: checkNaverLogStaleness() 추가 — 15분 무활동 시 알림
- PID 체크만으로 감지 못했던 크래시루프 상황 커버
- 30분 쿨다운 적용, 로그 없으면 스킵
<!-- session-close:2026-02-27:fe009-healthcheck-staleness-체크 -->

### ⚙️ FE-007 mosh 설치 및 아이패드 SSH 환경 개선 검토
- mosh 1.4.0 설치 완료 (brew install mosh)
- ~/.zprofile 생성 — SSH 로그인 셸 PATH 설정 (mosh-server 검색 가능)
- 검토 결과: 한글 입력 개선 없음(transport 무관 Ink 버그)
- 실제 이점: WiFi↔LTE 전환 시 세션 유지, 네트워크 복구
<!-- session-close:2026-02-27:fe007-mosh-설치-및-아이패드-ssh-환경-개선 -->

### ⚙️ FE-008 Claude Code 한글 버그 GitHub 이슈 #15705 코멘트 등록
- 기존 이슈 #15705 확인 (OPEN, 9개 코멘트, area:tui bug 레이블)
- 코멘트 추가: macOS 로컬(iTerm2) 재현 + rlwrap/mosh 무효 확인
- 단기 FE 백로그 전체 완료 (FE-002~009)
<!-- session-close:2026-02-27:fe008-claude-code-한글-버그-github -->

### ⚙️ MD-006: data.go.kr API 키 발급 가이드
- secrets.json 플레이스홀더 4개 추가
- improvement-ideas.md MD-006 완료 처리
- API 신청 가이드 작성
<!-- session-close:2026-02-27:md006-datagokr-api-키-발급-가이드 -->

### 🔧 픽코 타임아웃 근본 해결 + 자동 버그리포트 + ska-001 + SKA 통일
- pickko-accurate.js 7단계 page.click→evaluate (Runtime.callFunctionOn 타임아웃 근본 해결)
- pickko-cancel.js 3단계 page.$eval/click→evaluate 동일 수정
- naver-monitor.js autoBugReport() 추가 — 픽코 오류 시 bug-tracker 자동 등록
- ska-001 DuckDB 스키마 생성 (revenue_daily·environment_factors·forecast)
- bots/scar→bots/ska 디렉토리 + 전체 문서 SKA 통일
- MD-006 data.go.kr API 키 4종 secrets.json 등록 완료
<!-- session-close:2026-02-27:픽코-타임아웃-근본-해결-자동-버그리포트-ska001- -->

### ✨ ska-005~008 완료 — 이브크롤링+launchd 스케줄링
- ska-005 이브크롤링(큐넷+수능) — 547건 upsert 343일
- ska-008 launchd 4개 서비스 완료 — etl/eve/eve-crawl/rebecca
- scripts/send-telegram.py + scripts/run-rebecca.sh 생성
- ai.ska.etl(00:30)+ai.ska.eve(06:00)+ai.ska.eve-crawl(일04:30)+ai.ska.rebecca(08:00)
<!-- session-close:2026-02-27:ska005008-완료-이브크롤링launchd-스케줄링 -->

### ✨ ska-006 완료 — Prophet 매출 예측 엔진
- forecast.py Prophet 기본 엔진 (daily/weekly/monthly 3모드)
- regressor: exam_score+rain_prob+vacation_flag+KR 공휴일
- base_forecast=요일히스토리평균 / yhat=Prophet예측 / 신뢰구간 80%
- ai.ska.forecast-daily(매일18:00)+ai.ska.forecast-weekly(금18:00) launchd
- scripts/run-forecast.sh + requirements.txt prophet==1.3.0 추가
<!-- session-close:2026-02-27:ska006-완료-prophet-매출-예측-엔진 -->

### ✨ ska-007 완료 — Prophet regressor exam_events 연동
- forecast.py prophet-v1→v2 업그레이드
- load_history: exam_events JOIN으로 역사데이터 exam_score 강화
- load_future_env: UNION approach로 env+exam_events 완전 커버
- 3월 학력평가 score=5 자동 반영 확인 (3/12 당일, 3/7~11 D-7 prep)
<!-- session-close:2026-02-27:ska007-완료-prophet-regressor-ex -->

### ✨ ska-014/015: 대학교 크롤링 + 공무원 정적 캘린더
- ska-014: 가천대·단국대 죽전 시험기간 Playwright 크롤링
- ska-015: 공무원 시험 정적 캘린더 (국가직9급·지방직9급·7급·경찰·소방)
- upsert_events source 파라미터 추가 (calc/crawl/static 구분)
- exam_events: 850행 (calc547+crawl148+static155)
- 4월 중간고사 exam_score 피크 12~15 정상
<!-- session-close:2026-02-27:ska014015-대학교-크롤링-공무원-정적-캘린더 -->

### ⚙️ 설계문서 v2.1: 레베카 LLM 제거 확정
- ska-design.md v2.1 업데이트
- 레베카 LLM 완전 제거 (팀 테이블·LLM 레이어·리포트 종류·피드백 루프)
- LLM은 포캐스트 월간 전담으로 확정
- launchd 스케줄 전체 17개 plist 현황 반영
- Phase 1·2 완료 표기
<!-- session-close:2026-02-27:설계문서-v21-레베카-llm-제거-확정 -->

### ⚙️ 설계문서 v2.2: Phase 3/3+ 루프 자동화 로드맵
- Phase 3 목표 명확화 (진단→수동 적용, 반자동, 3개월+)
- Phase 3+ 신설 (완전 자동 루프, 6개월+, 백테스트+롤백)
- 루프 구조 요약 섹션 추가 (Phase별 자동화 수준)
- ska-design.md v2.2 업데이트
<!-- session-close:2026-02-27:설계문서-v22-phase-33-루프-자동화-로드맵 -->

### ⚙️ tmux Remote Control 설정 + LLM API 코드 개선
- tmux 설치 + ai.ska.tmux launchd 등록 (재부팅 자동 복구)
- 아이패드 Claude Remote Control (/rc) 연결 확인
- forecast.py _call_llm_diagnosis system 파라미터 분리 + Prompt Caching + temperature=0.1 + 에러 세분화
- coding-guide.md 섹션 12/13 Anthropic SDK 직접 호출 패턴 + temperature 가이드 + 모델 표 추가
<!-- session-close:2026-02-27:tmux-remote-control-설정-llm-api -->

### ♻️ CL-006 코딩가이드 기준 전체 코드 리팩토링
- maskPhone/maskName 함수 추가 (lib/formatting.js)
- JS 8개 파일 개인정보 로그 마스킹 (phone/name)
- Python DB 연결 try/finally 래핑 (etl/rebecca/eve)
- Python 에러 묵음→경고 출력 (etl/eve/eve_crawl)
- writeFileSync→saveJson 전환 (naver-monitor/bug-report)
- inspect-naver.js 하드코딩 경로 제거
<!-- session-close:2026-02-27:cl006-코딩가이드-기준-전체-코드-리팩토링 -->

### ⚙️ pickko-daily-audit/summary 실행 시간 23:50으로 변경
- pickko-daily-audit 22:00→23:50 (plist 수정 + launchd 재등록)
- pickko-daily-summary 00:00→23:50 (LaunchAgents plist 수정 + launchd 재등록)
<!-- session-close:2026-02-27:pickkodailyauditsummary-실행-시간- -->

## 2026-02-26

### 스카봇 — 신규 기능
- **pickko-ticket.js** — 픽코 이용권 추가 CLI (9단계 자동화, 기간권 중복 방지)
- **pickko-daily-summary.js** — 09:00 예약현황 / 00:00 마감 매출+컨펌 (launchd)
- **lib/pickko-stats.js** — fetchMonthlyRevenue/fetchDailyRevenue/fetchDailyDetail
- **매출 분리** — `daily_summary` 테이블에 pickko_total/pickko_study_room/general_revenue 추가, 일반이용 매출 별도 표시
- **pickko-revenue-confirm.js** — 미컨펌 daily_summary → room_revenue 누적 + 텔레그램
- **pickko-stats-cmd.js** — 날짜/주/월/누적 매출 자연어 조회 CLI
- **pickko-query.js** — 예약 조회 (날짜/이름/전화/룸 필터) CLI
- **pickko-cancel-cmd.js** — 자연어 취소 명령 래퍼 (stdout JSON)
- **자연어 E2E 테스트** — `test-nlp-e2e.js` 27케이스 100% 통과

### 스카봇 — 인프라
- **JSON → SQLite 마이그레이션** — `state.db` 단일 파일, AES-256-GCM 암호화, 6개 JSON → 4개 테이블
- **lib/crypto.js** — AES-256-GCM 암호화/복호화, SHA256 kiosk 해시 키
- **lib/telegram.js** — Telegram Bot API 직접 발송 (openclaw 우회), 3회 재시도
- **lib/pickko.js** `fetchPickkoEntries()` 공유 함수 추출 (4개 스크립트가 재활용)
- `fetchPickkoEntries` `sortBy='sd_regdate'` + `receiptDate` 옵션 추가
- **session-close 라이브러리** — `scripts/lib/` 모듈화, `session-close.js` CLI

### 스카봇 — 텔레그램 안정화
- **pending queue** — 3회 재시도 최종 실패 시 `pending-telegrams.jsonl` 저장, 재시작 시 자동 재발송
- **start-ops.sh self-lock** — `SELF_LOCK` 중복 실행 방지 (PID 파일 체크)
- `sendTelegramDirect` async 변환, 3회 재시도 (3초/6초 백오프)

### 스카봇 — 버그 수정
- pickko-accurate.js [5단계] `page.click()` → `page.evaluate()` 교체 (protocolTimeout 해결)
- pickko-accurate.js [1.5단계] `syncMemberNameIfNeeded()` — 픽코↔네이버 이름 자동 동기화
- pickko-cancel.js [6-B단계] — 0원/이용중 예약 취소 폴백 (수정→취소→저장)
- pickko-cancel.js [7-B단계] — 결제대기 예약 취소 폴백
- pickko-kiosk-monitor.js Phase 2B 필터 버그 수정 (naverBlocked 여부 확인 추가)
- pickko-kiosk-monitor.js `verifyBlockInGrid` 재작성 (DOM 좌표 기반 정확한 검증)
- naver-monitor.js 취소 감지 2 조건 개선 (`cancelledHref` null일 때 폴백 방문)

### 스카봇 — 키오스크 자동화 완성
- **pickko-kiosk-monitor.js Phase 2B + 3B** — 키오스크 예약 취소 감지 → 네이버 예약불가 자동 해제
  - `unblockNaverSlot()`: suspended 슬롯 클릭 → fillAvailablePopup → verifyBlockInGrid
  - `clickRoomSuspendedSlot()`, `selectAvailableStatus()`, `fillAvailablePopup()` 신규 함수

### OpenClaw
- **gemini-2.0-flash → gemini-2.5-flash** 모델 교체 (운영 중)
- LLM API 속도 테스트 결과 기록 (groq 1위 203ms, gemini 4위 608ms)

---

## 2026-02-25

### 스카봇 — 신규 기능
- **pickko-daily-audit.js** — 당일 픽코 등록 사후 감사 (22:00+23:50 launchd)
- **pickko-register.js** — 자연어 예약 등록 CLI (stdout JSON)
- **pickko-member.js** — 신규 회원 가입 CLI (stdout JSON)
- **pickko-kiosk-monitor.js** Phase 1~5 전체 완성
  - 키오스크 결제완료 감지 → 네이버 booking calendar 자동 차단
  - `run-kiosk-monitor.sh` + `ai.ska.kiosk-monitor.plist` launchd 30분 주기

### 스카봇 — 안정화 8건
- `lib/files.js saveJson()` 원자적 쓰기 (tmp→rename)
- `pickko-accurate.js` 슬롯 재시도 1회→3회
- `naver-monitor.js rollbackProcessingEntries()` exit 전 롤백
- `start-ops.sh` 로그 1000줄 로테이션
- `naver-monitor.js pruneSeenIds()` 90일 초과 항목 정리
- `ai.ska.pickko-daily-audit.plist` 23:50 실행 추가 (22:00+23:50 2회)

### 스카봇 — 버그 수정
- `pickko-cancel.js` 취소 플로우 완전 재작성 (올바른 환불 플로우: 주문상세→상세보기→환불 버튼)
- `pickko-verify.js needsVerify()` — completed+paid/auto 항목도 재검증 대상 포함
- 테스트 예약불가 4건 복원 + 루트 임시 파일 11개 삭제 정리

---

## 2026-02-24

### 스카봇 — 신규 기능
- **픽코 자동 취소** — `pickko-cancel.js` 신규, naver-monitor.js 취소 감지 추가
- **OPS 취소 활성화** (`PICKKO_CANCEL_ENABLE=1`)
- **Heartbeat** 추가 (1시간 주기, 09:00~22:00 텔레그램)
- **log-report.sh** 신규 + launchd `ai.ska.log-report` 3시간 주기
- **pickko-verify.js** — pending/failed 예약 재검증 스크립트
- **pickko-verify.js 자동 스케줄링** — `run-verify.sh` + launchd 08:00/14:00/20:00

### 스카봇 — 인프라
- **lib/ 공유 라이브러리 리팩토링** — 7개 신규 모듈 (utils/secrets/formatting/files/args/browser/pickko)
- 4개 src 파일 중복 코드 220줄 제거
- **CLAUDE_NOTES.md** 시스템 구축 (클로드→스카 전용 채널 파일)
- **SYSTEM_STATUS.md** 자동 생성 (`deploy-context.js updateSystemStatus()`)

### 스카봇 — 로직 개선
- 취소 감지 → `previousConfirmedList` 리스트 비교 방식 (카운터 비교 폐기)
- 보안인증 대기 30분 + 텔레그램 알림 (원격 인증 지원)
- 모니터링 주기 3분 (`NAVER_INTERVAL_MS=180000`)
- `validation.js` 24:00 지원
- 야간 알림 차단 + `flushPendingAlerts` 09:00 일괄 발송

### OpenClaw
- gemini-2.0-flash → gemini-2.5-flash 교체 (첫 번째 시도, deprecated 대응)

---

## 2026-02-23

### 인프라
- **RAG 시스템** 구축 (`~/projects/rag-system`, FastAPI + ChromaDB, 포트 8100, Python 3.12)
- naver-monitor.js RAG 연동 (예약 이력 자동 저장)
- OpenClaw Gemini 모델 전환 (텔레그램 응답 정상화)

### 스카봇 — 인프라
- **BOOT.md** 자동 기억 복원 시스템 구축
- **컨텍스트 관리 시스템** — `registry.json` + `deploy-context.js`
- **nightly-sync.sh** + launchd 자정 자동 보존 시스템
- 모델 변경 자동 컨텍스트 보존 (BOOT 1단계 sync 자동 실행)
- `start-ops.sh` 자동 재시작 루프 + `cleanup_old()` 구 프로세스 정리
- naver-monitor.js 락 로직 개선 (SIGTERM→SIGKILL)

### 스카봇 — 버그 수정
- `process.exit(0)` 버그 수정 (픽코 성공이 exit code 1로 오인되던 문제)
- DEV/OPS 데이터 파일 분리 (`naver-seen-dev.json` / `naver-seen.json`)
- detached Frame 버그 수정 (`runPickko()` 내 `naveraPage.close()` 제거)

---

## 2026-02-22

### 스카봇 — 최초 완성
- `naver-monitor.js` 재작성 (네이버 파싱 10건 성공)
- `pickko-accurate.js` Stage [6] 4-Tier Fallback 완성
- DEV 모드 전체 테스트 — Stage [1-9] 완전 성공
- OPS/DEV 로직 분리 + 알람 시스템
- **22:00 — OPS 모드 전환** (사장님 협의, 실운영 시작) ✅

---

## 통계 요약

| 기간 | 주요 마일스톤 |
|------|------------|
| 2026-02-22 | OPS 모드 전환 (실운영 시작) |
| 2026-02-23 | RAG 시스템 + 컨텍스트 관리 기반 구축 |
| 2026-02-24 | 자동 취소 + 공유 라이브러리 리팩토링 |
| 2026-02-25 | 키오스크 모니터 + 안정화 8건 |
| 2026-02-26 | SQLite 마이그레이션 + 매출 분리 + NLP E2E 100% |
| 2026-02-27 | 공유 인프라 + 백그라운드 전환 + BOOT 8.4× 개선 |
| 2026-02-28 | ETL 버그 수정 + OpenClaw 업데이트 + ska DB 백필 |
| 2026-03-01 | 루나팀 Phase 0 드라이런 + 덱스터 + 아처 + KIS 크리스 구현 |
| 2026-03-03 | 스카팀 고도화 v3.0 + 루나팀 크립토 OPS 전환 + 실행체인 버그 수정 + ETH→USDT |
| 2026-03-04 | RC 세션 폭발 버그 수정 + tmux/RC 전체 제거 + 루나팀 Phase 3 고도화 + DuckDB WAL 버그 수정 + 암호화폐 OPS 전환 |

---

## 2026-03-17

### 팀별 운영 변수 외부화 정리
- `investment`
  - `runtime_config` 기반으로 루나/네메시스/time-mode 운영 임계치 외부화
  - 암호화폐와 국내외장 실행 모드는 분리 유지, 공용 헬퍼에서 통합 관리
- `reservation`
  - 브라우저 launch 재시도, timeout, stale 판정, monitor 재시도 한도 외부화
- `ska`
  - forecast / rebecca / 리뷰 스크립트 운영 기준 외부화
  - Python/Node가 같은 설정 파일을 읽도록 정리
- `worker`
  - worker lead / n8n intake / health timeout 외부화
  - web client auth timeout / reconnect delay 외부화
- `orchestrator`
  - critical path URL, timeout, payload warning 기준 외부화
- `claude`
  - dexter-quickcheck / n8n / pattern 체크 임계치 외부화
- `blog`
  - health/n8n timeout + generation length/retry/continue token 기준 외부화

### 운영 문서/도구 정리
- `docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md` 작성
- `scripts/show-runtime-configs.js` 추가
- 운영자가 코드 대신 설정 파일을 먼저 확인하도록 팀별 관리 포인트 문서화

### 루나팀 운영 보정
- 국내/해외장을 모의투자 기준으로 다시 정렬
- 국내/해외 주문 금액 clamp 기준 보정
- 자동매매 일지/주간 리뷰를 `암호화폐 / 국내장 / 해외장` 섹션으로 분리
- 로그의 `[PAPER]` / `KIS PAPER=true` 표현을 실제 실행 상태와 맞춤

### 덱스터 false positive 완화
- 고아 Node 프로세스 오탐 축소
- Swap 경고 기준 완화
- `forecast_results` 누락을 경고에서 분리

### 추가 개발 메모
- `runtime_config` 후보값을 일일/주간 분석해서 변경 제안하는 자동화 필요
- 제이 전용 LLM 리뷰는 유지하고, 전체 LLM 리뷰는 운영 분석 리포트와 중복 축소 가능
- 다음 운영 단계는 “추가 외부화”보다 “실제 운영 중 바꾸는 값 수집”이 더 중요

---

## 2026-03-04

### 긴급 — claude remote-control 세션 폭발 사고 (2,407건)
- `ai.agent.cc-remote` launchd → `cc-remote-start.sh` (while true 루프) 실행 중
- `claude remote-control` 내부 버그: `--sdk-url <session_id>` 노드 플래그 전달 → 즉시 실패 → 10초 후 재시작 루프
- 발견 당시 2,407개 세션 생성됨
- 대응: PID 65530 종료 → launchd unload → plist + script 삭제

### tmux / Termius / Remote Control 전체 제거
- 삭제 항목: `ai.agent.cc-remote.plist`, `ai.agent.tmux.plist`, `ai.ska.tmux.plist`
- 삭제 스크립트: `cc-remote-start.sh`, `update-rc-context.sh`, `tmux-start.sh`, `~/start-ska-session.sh`
- 삭제 파일: `RC_CONTEXT.md`, `config/tmux-windows.json`
- `CLAUDE.md` Remote Control 섹션 제거, `~/.zshrc` alias 제거
- `bots/claude/lib/checks/bots.js` `ai.ska.tmux` 체크 제거

### 루나팀 Phase 3 고도화 v2 (TASK 4~9)
- **TASK 4**: `launchd/ai.investment.argos.plist` 생성 (6시간 주기, 아르고스 전략 수집)
- **TASK 5**: `team/aria.js` — `isMarketOpen(exchange)` export + KIS/KIS Overseas 장중 가드
- **TASK 8**: `shared/cost-tracker.js` — `reportToTelegram()` 메서드 클래스 내부 이동 (class 외부 선언 버그 수정)
- **TASK 9**: `team/chronos.js` — CJS → ESM 전환 + `chronosGuard()` 추가

### DuckDB WAL 재생 버그 수정
- 증상: `[Error: Connection was never established]` — DB 오픈 시마다 실패
- 원인: `ALTER TABLE signals ADD COLUMN` WAL 진입을 DuckDB 1.4.4가 재생 불가
  - 버그 메시지: `Calling DatabaseManager::GetDefaultDatabase with no default database set`
- 해결: `shared/db.js` `initSchema()` 끝에 `CHECKPOINT` 추가 → WAL을 메인 DB로 즉시 플러시
- 검증: 단독 initSchema + 연속 2회 오픈 모두 성공

### E2E 전체 테스트 통과
- crypto: 6.8초 ✅ | domestic: 5.7초 ✅ (장 마감, 아리아 스킵 정상) | overseas: 9.2초 ✅

### 암호화폐 OPS 전환 (LIVE 실거래 테스트)
- `PAPER_MODE=false node markets/crypto.js --force` 실행
- 결과: BTC/USDT BUY 68% → 네메시스 $100 승인 → 헤파이스토스 실행 시도 → 잔고 부족 ($14.02)
- 파이프라인 완전 정상 동작 확인 (Haiku LLM 사용 확인)

### LLM 정책 v2.2 — Groq 전용
- 사용자 지시: "llm은 groq 유지한다"
- `shared/llm-client.js` 변경: `HAIKU_AGENTS` 제거, 전 모드 Groq Scout 전용
- 결과: LIVE 모드도 Groq (무료, $0/월)

### 투자 리포트 시스템 (team/reporter.js)
- 바이낸스 실잔고 + 모의 포지션 미실현 PnL + 신호 통계 + LLM 비용
- `npm run report` / `npm run report:tg`
- 첫 리포트 텔레그램 발송 완료

### 커밋 내역
- `0395e8d` Phase 3 고도화 (TASK4-9): argos plist, aria 시장가드, chronos ESM, cost-tracker
- `fa273f6` DuckDB WAL 수정 + cost-tracker reportToTelegram 클래스 내부 이동
- `915859c` LLM 정책 v2.2 — Groq 전용
- `d603831` 투자 리포트 시스템 (reporter.js)

## 2026-03-05 (세션 다수)

### 출금지연제 자동예약 + 덱스터 Phase C
deps.js cd→cwd 수정(launchd PATH 오류) | git 상태 패턴 저장 제외(false positive) | getNewErrors 중복 수정(GROUP BY) | node→process.execPath 수정 | 업비트 출금지연제 자동예약(luna-commander) | 신규감지 창 24h→8h | --clear-patterns CLI | RAG 서버 optional 처리

### 헬스체크 회복 로직 + 제이 할루시네이션 방지
health-check.js 회복 감지·알림·state 저장 | backup-db.js async 누락 수정 | TOOLS.md bot_commands 명령 테이블 + 할루시네이션 방지 경고

### 스카팀 취소 루틴 버그 수정
page.click(body)→Escape 키 수정(상세보기 블러 문제) | toCancelKey bookingId 기반 개선(슬롯 재예약 키 충돌 방지)

### 루나팀 국내/국외 모의투자 배포
국내장 모의투자 활성화(ai.investment.domestic) | 포트폴리오 프롬프트 심볼 환각 버그 수정(luna.js) | 덱스터 신호 exchange 불일치 감지 추가

### LLM 토큰 이력 DB 기록 + 거래 일지
llm-client.js Groq/OpenAI 토큰·응답시간 DB 기록 | token_usage 테이블 duration_ms 컬럼 | scripts/trading-journal.js 신규

### OpenClaw 업데이트 + 제이 RAG 연동
OpenClaw 2026.2.26→2026.3.2 | TOOLS.md RAG 검색 섹션(system_docs 12건 임베딩) | state.db e2e 테스트 데이터 삭제

### 덱스터 AI 분석 레이어 + 2-티어 퀵체크
- bots/claude/lib/ai-analyst.js: OpenAI gpt-4o-mini/4o 종합 진단, dexter-insights.json (최대 20개 FIFO)
- bots/claude/src/dexter-quickcheck.js: 5분 주기 크래시 감지·자동재시작·중복알림방지
- ai.claude.dexter.quick launchd 등록 (StartInterval=300, --telegram --fix)
- 덱스터 체크 티어: quick(5분) + full(1h)

### 클로드팀 개선 5가지
bot-behavior.js 신규(독터루프+실패율+루나급속신호) | doctor.js RAG 복구 실패 저장+getPastSuccessfulFix | claude-lead-brain.js Shadow 4단계(CLAUDE_LEAD_MODE) | health-dashboard-server.js 포트3032 | deps.js 패치티켓 RAG 자동저장

### 시스템 인프라 개선 3가지
scripts/weekly-team-report.js 4팀 KPI 주간리포트 | pg-pool getAllPoolStats/checkPoolHealth/getClient 추가 | 카오스테스트 3종(db-pool-exhaust/llm-failover/telegram-rate-limit)

### 블로그팀 Phase 1 MVP (2026-03-09)
blo.js(팀장) + richer.js(IT뉴스/HN/날씨) + pos-writer.js(강의8000자+) + gems-writer.js(일반7000자+) + publ.js(마크다운저장) | 지원모듈: category-rotation/quality-checker/daily-config | blog 스키마 5테이블 마이그레이션 완료 | 120강 커리큘럼 시딩 완료 | ai.blog.daily launchd 등록(06:00 KST)

### 블로그팀 팀 제이 핵심 기술 통합 + 구글드라이브 저장 (2026-03-09)
RAG/MessageEnvelope/trace/StateBus/tool-logger/llm-cache/mode-guard 통합 | quality-checker AI탐지리스크(0~100) | GEO/AEO + ai-agent-system 컨텍스트 시스템프롬프트 통합 | RAG 실전에피소드+내부링킹 자동화 | 리라이팅가이드 텔레그램 포함 | publ.js 구글드라이브 자동저장(/010_BlogPost) | 글자수 기준 실측조정(강의7000/일반3500) | 전파이프라인 통과(강의8018자, 일반3990자) | rag_blog 컬렉션 pgvector 추가 | 커밋: a12364e, e361917, dae45f6
