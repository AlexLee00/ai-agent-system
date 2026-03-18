# AI 협업 개발 저널: 스카봇 (Ska) 구축기

> **목적:** AI(Claude Code)와 함께한 개발 과정을 기록하여 바이브 코딩(Vibe Coding) 방법론을 연구한다.
> **기간:** 2026-02-22 ~ 진행 중
> **프로젝트:** 스터디카페 예약관리 자동화봇 (스카, Ska) + 멀티 에이전트 AI 시스템
>
> 이 저널은 **비개발자가 AI와 협업하여 프로덕션 봇을 만드는 과정**을 솔직하게 기록합니다.
> 코드 한 줄 없이 시작해서 실제 운영 중인 봇을 만드는 과정에서 배운 것들,
> AI와 효과적으로 협업하는 방법, 그리고 실패와 성공의 경험을 공유합니다.

---

## 2026-03-16~18: 플랫폼화 단계 — 운영형 AI 시스템으로 수렴

### 배경

초기에는 스카 예약 자동화가 가장 앞에 있었지만, 지금은 시스템이 훨씬 넓어졌다.

- 워커: 자연어 기반 업무 입력, 문서 파싱/OCR, 승인/재사용 흐름
- 루나: 자동매매 분석/리뷰/튜닝 루프
- 스카: 예측 엔진, 예약 모니터, 운영 안정화
- 제이: 오케스트레이션과 인텐트 라우팅
- 클로드/덱스터: 유지보수와 운영 진단

즉 더 이상 “봇 하나를 잘 만드는 문제”가 아니라,  
**운영 데이터가 남고, 다음 세션과 다음 운영 판단으로 이어지는 시스템을 만드는 문제**로 옮겨갔다.

### 핵심 의사결정

**DEC-005 | 새 모델은 대체가 아니라 shadow 비교로 붙인다**
- 스카 예측 엔진의 과소예측 편향을 보면서, 다른 계열 모델을 붙일 필요가 생겼다.
- 그러나 기존 엔진을 바로 교체하면 운영 리스크가 크다.
- 그래서 `knn-shadow-v1`를 `shadow`로만 저장하고, actual이 쌓인 뒤 `primary vs shadow`를 비교하는 구조를 선택했다.

**이유**
- 내부 MVP 단계에서 안전성이 우선
- 운영 데이터 기반으로 실제 개선 여부를 증명 가능
- SaaS 확장 시 tenant별 shadow 실험 구조로 확장 가능

**결과**
- `forecast_results.predictions`에 shadow 정보가 저장되기 시작했다.
- 일일/주간 리뷰와 자동화도 shadow 비교를 읽는 구조로 확장됐다.

---

**DEC-006 | 문서 파싱은 기능이 아니라 운영 데이터 축으로 본다**
- 워커 문서 파싱/OCR은 단순 업로드 기능이 아니었다.
- 실제로 중요한 것은:
  - 어떤 문서가
  - 어떤 업무 화면으로 재사용되었고
  - 실제 어떤 결과를 만들었는가
를 남기는 것이다.

**이유**
- AI Ops Platform에서 “문서를 읽을 수 있다”보다 “문서를 실제 업무에 얼마나 유효하게 썼는지”가 더 중요하다.
- 이후 품질 평가, 수정량 분석, 고객 SaaS 확장 시 감사 추적에도 연결된다.

**결과**
- 문서 상세
- 재사용 이벤트 저장
- 생성 결과 연결
- 문서별 전환율/성과 요약
까지 한 사이클이 닫혔다.

---

**DEC-007 | 문서체계는 새 문서를 늘리기보다 역할을 분리한다**
- 기능이 늘면서 문서도 같이 늘어났고, 세션마다 다시 찾는 비용이 커졌다.
- 그래서 “문서를 더 많이 만드는 것”이 아니라 “문서가 어떤 역할을 맡는지”를 먼저 분리했다.

문서 역할은 이렇게 정리됐다.
- 정책: `CLAUDE.md`
- 세션 인덱스: `SESSION_CONTEXT_INDEX.md`
- 현재 구현 상태: `PLATFORM_IMPLEMENTATION_TRACKER.md`
- 세션 인수인계: `SESSION_HANDOFF.md`
- 세션 사실 기록: `WORK_HISTORY.md`
- 장기 연구 기록: `RESEARCH_JOURNAL.md`
- 기능 변경 이력: `CHANGELOG.md`

**결과**
- 세션이 바뀌어도 읽는 순서가 고정되기 시작했다.
- 다음 세션이 소스코드를 전부 읽지 않아도, 어디를 봐야 하는지 더 빨리 파악할 수 있게 됐다.

---

**DEC-008 | 세션 기록도 기존 문서에 흡수한다**
- 개발 연속성을 위해 세션 기록은 꼭 필요하지만, 같은 성격의 문서를 계속 늘리면 오히려 읽는 비용이 다시 커진다.
- 그래서 세션 단위 사실/맥락 기록은 `WORK_HISTORY.md`에, 장기 연구와 회고는 `RESEARCH_JOURNAL.md`에 흡수하는 쪽이 더 맞다고 판단했다.

**이유**
- 내부 MVP 단계에서는 문서 수보다 탐색 속도가 더 중요하다.
- 운영자와 다음 세션의 개발자가 “어디를 봐야 하는지”를 한 번에 알 수 있어야 한다.
- 이후 SaaS 확장 시에도 핵심은 문서의 개수가 아니라 역할의 선명함과 연결성이다.

**결과**
- 세션 시작 시 읽는 경로는 `CLAUDE.md -> SESSION_CONTEXT_INDEX.md -> SESSION_HANDOFF.md -> PLATFORM_IMPLEMENTATION_TRACKER.md`로 더 짧아졌다.
- 세션 종료 시 기록도 `WORK_HISTORY.md`, `RESEARCH_JOURNAL.md`, `SESSION_HANDOFF.md` 중심으로 모아지는 구조가 됐다.

### 기술 인사이트

**1. 운영형 AI 시스템은 “기능 수”보다 “이력의 질”이 중요하다**
- 로그
- 실패 이력
- 재사용 이력
- 승인/수정 흐름
- 예측 결과와 actual 비교

이런 흔적이 남아야 시스템이 점점 나아질 수 있다.

**2. 보수적 자동화가 과감한 자동화보다 장기적으로 강하다**
- 일일 운영 분석 리포트는 fallback이 약하면 `hold`가 맞다.
- 스카 새 모델도 바로 교체보다 shadow가 맞다.
- 운영 봇은 화려한 판단보다 과장하지 않는 판단이 더 중요하다.

**3. SaaS 확장을 생각하면 지금부터 scope와 trace를 남겨야 한다**
- 내부 운영용 MVP라도
  - 설정값 변경 근거
  - 예측/판단 비교
  - 문서 재사용 이력
  - 사용자 수정 흐름
를 남겨야 나중에 멀티테넌트 SaaS로 갈 수 있다.

### 현재 해석

이제 이 프로젝트는 “예약봇/투자봇/업무봇을 하나씩 만드는 단계”를 지나,  
**운영 데이터가 신뢰 가능하고, 다음 세션과 다음 판단으로 이어지는 플랫폼 단계**로 들어왔다.

다음 연구 질문은 더 명확하다.

- shadow 모델은 언제 promotion 할 것인가
- 문서 재사용 품질은 어떻게 수치화할 것인가
- 운영 리포트 자동화의 신뢰도를 어떻게 더 높일 것인가

### 2026-03-18 세션 회고

이번 세션에서 코덱이 가장 강하게 본 문제는 “기능은 올라왔는데, 세션이 바뀌면 다시 맥락을 찾는 비용이 크다”는 점이었다.

- 스카는 `새 모델을 넣을 것인가`보다 `어떻게 안전하게 비교할 것인가`가 핵심이었다.
- 워커는 `문서를 읽을 수 있는가`보다 `문서가 실제 업무를 얼마나 만들어내는가`가 중요했다.
- 문서체계는 `무슨 문서를 더 만들까`보다 `어디에 기록을 모아야 덜 헤매는가`가 중요했다.

즉 이번 세션의 공통 판단은 세 가지였다.

- 스카는 `shadow`
- 워커는 `reuse trace`
- 문서는 `existing-doc consolidation`

이 세 결정은 모두 같은 방향을 향한다.  
운영형 AI 시스템은 기능 수보다 `근거`, `이력`, `다음 판단으로 이어지는 연결성`이 더 중요하다는 점이다.

---

## 2026-03-18: 운영자가 오해하지 않게 보이게 만드는 일

오늘은 기능을 더 붙인 날이기도 했지만, 그보다 더 정확하게 말하면 “운영자가 시스템 상태를 헷갈리지 않게 만드는 일”을 한 날이었다.

워커에서 새로 붙인 `워커 모니터링`은 단순히 드롭다운 하나를 만든 게 아니다.

- 지금 어떤 LLM API가 실제 관리자 분석 경로에 적용되는지
- 그 선택이 어디에 저장되는지
- 어떤 경로는 바뀌고 어떤 경로는 고정인지

를 운영 화면에서 설명 가능하게 만든 것이다.

이건 내부 MVP에서 특히 중요하다. 기능이 많아질수록 “실제로 지금 뭐가 적용되고 있는가”를 설명할 수 없으면 운영이 불안해진다.  
나중에 SaaS로 확장할 때도 tenant별 정책/기본 provider/override를 설명할 수 있어야 한다.

투자팀에서도 비슷한 문제가 있었다.

- `paper/live`
- `실거래/모의거래`
- `모의투자 계좌`

이 표현이 섞이면서, 자산과 직접 연결되는 리포트에서 해석이 흔들릴 수 있었다.  
그래서 `executionMode`와 `brokerAccountMode`를 분리한 것은 단순 네이밍 정리가 아니라, 운영 해석 불변식을 다시 세운 일에 가깝다.

덱스터도 마찬가지였다.

오류를 많이 잡는 것보다,  
**진짜 오류만 남기고 저위험 dev-state는 과장하지 않는 것**이 더 중요했다.

오늘의 공통 주제는 결국 하나였다.

- “이 시스템이 지금 무엇을 하고 있는지, 운영자가 오해 없이 읽을 수 있는가?”

코덱은 이 질문이 앞으로도 계속 중요하다고 본다.  
기능이 늘수록 설명 가능성과 추적 가능성이 더 중요한 자산이 되기 때문이다.

---

## 2026-03-06~07: 1주차 — 3계층 아키텍처 핵심 기반 구축

### 배경
단방향 알림 기반(봇 → 텔레그램 → 마스터)에서 **3계층 자율 에이전트 모델**로 전환.
- Layer 1: 팀원 봇 (규칙 기반, 실행·보고)
- Layer 2: 팀장 봇 (LLM, 자율 판단·조율) — 구조 생성, LLM 판단은 2~4주차
- Layer 3: 마스터 (전략, 예외 승인)

1주차 목표: 인프라 기반(State Bus, 로거, 캐시, 라우터, 독터, 매매일지) 구축.

### 핵심 의사결정

**TP/SL: Spot OCO 선택**
- Futures에서는 TP/SL을 포지션 단계에서 설정 가능하지만, Spot은 OCO 방식이 최선
- TP +6%, SL -3% 고정 비율 (R/R 2:1). 향후 네메시스가 동적 산출 예정

**State Bus: state.db 통합 (별도 DB 미생성)**
- Redis 등 별도 메시지 브로커 대신 SQLite 기반 State Bus 선택
- 이유: 외부 의존성 제로, 동일 서버에서 운영, WAL 모드로 동시 접근 안전

**팀장 간 소통: sessions_send 대신 State Bus**
- OpenClaw `sessions_send`가 아직 실험적 상태 → State Bus의 `agent_events` 기반으로 대체
- team-comm.js를 추상화 계층으로 두어 향후 sessions_send 전환 용이하게 설계

**이중 모드 (Normal/Emergency): 인프라 장애 기반**
- OpenClaw/스카야 3분 이상 다운 시 비상 모드 전환
- 팀장 미구축이므로 팀장 무응답 기반 전환은 3주차로 연기

**독터 블랙리스트 설계**
- `rm -rf`, `DROP TABLE`, `DELETE FROM`, `kill -9`, `git push --force`, `--hard` 등 9개
- JSON 직렬화 후 문자열 포함 여부 검사 → 파라미터 주입 공격도 차단

**LLM 로거/라우터/캐시 공용 모듈화**
- `packages/core/lib/`에 통합 → 팀별 중복 구현 방지
- 라우터는 DB 의존 없는 순수 함수형 설계 (테스트 용이)
- 캐시 키: 불용어 제거 + 키워드 정렬 + SHA256 (벡터 DB 없이 시맨틱 유사도 근사)

### 시행착오
- **tmux 세션명**: CLAUDE.md에 "skaya"로 기록됐으나 실제는 "ska". launchd plist 기준으로 수정
- **덱스터 오류 이력 무한 누적**: `cleanup()` 함수가 구현됐으나 호출 코드가 없었던 버그. 7일 보존 + `markResolved()`로 근본 수정
- **openclaw.js IPv6 파싱 오탐**: `::1` 주소를 `split(':')` 하면 `''` → wildcard로 오인. bracket notation 처리 추가
- **insertReview 파라미터**: `insertReview(review)` 아닌 `insertReview(tradeId, review)` — ESM과 CJS 혼재 시 함수 시그니처 확인 필요

### 기술 인사이트

**Shadow Mode 3단계 전환 전략**
1. Shadow: LLM이 판단하되 로그만 기록 (규칙이 실행)
2. Confirmation: LLM 판단 + 사람이 승인
3. LLM Primary: LLM이 직접 실행 (규칙은 안전망)
→ 일치율 95%+ 달성 시 다음 단계 전환

**LLM 졸업 (LLM Graduation)**
- 반복 패턴을 규칙으로 전환하는 개념
- 로거가 패턴 감지 → 마스터 승인 → 규칙으로 코드화 → LLM 호출 감소 = 비용 절감

**매매일지의 분석팀 성적표**
- 각 봇(아리아/소피아/오라클/네메시스)의 신호 정확도를 trade_journal로 측정 가능
- 예: `aria_accurate` 컬럼 집계 → 아리아 TA 신호 신뢰도 측정

**독터의 화이트리스트 설계 원칙**
- 허용 목록만 나열 (기본 거부) + 블랙리스트로 이중 차단
- `requires_confirmation: true` 작업은 현재 마스터에게 텔레그램 요청으로 처리
  → 향후 팀장 봇이 승인/거부 역할 담당 예정

---

## 1. 프로젝트 개요

### 무엇을 만들었나

네이버 스마트플레이스에 들어오는 스터디룸 예약을 자동으로 픽코(Pickko) 키오스크에 등록/취소하는 봇. 사장님이 핸드폰으로 텔레그램 명령을 보내면 봇이 실행하고 결과를 알려준다.

```
네이버 예약 감지 (3분 주기)
    ↓
픽코 키오스크 자동 등록/취소
    ↓
텔레그램 알림
```

### 기술 스택

- **Node.js + Playwright** — 웹 자동화
- **SQLite (better-sqlite3)** — 상태 저장
- **OpenClaw** — AI 게이트웨이 (Gemini-2.5-flash)
- **텔레그램 봇** — 사용자 인터페이스
- **macOS launchd** — 프로세스 스케줄링

### 개발자 구성

| 역할 | 담당 |
|------|------|
| 제품 오너 + 도메인 전문가 | 사용자 (스터디카페 사장님) |
| 아키텍처 설계 + 코딩 실행 | Claude Code (AI) |
| 방향 결정 + 검증 + 운영 판단 | 사용자 |

---

## 2. 개발 방법론: 바이브 코딩

### 2-1. 세션 기반 개발

하나의 대화 세션 = 하나의 작업 블록. 세션 간 컨텍스트 유지를 위해 `BOOT.md`를 자동 생성하고, 게이트웨이 재시작 시 봇이 스스로 읽어서 현황을 복원한다.

**패턴:**
```
세션 시작 → 현황 파악 (BOOT.md 읽기) → 작업 → 테스트 → 세션 마감 (session-close.js)
```

세션 마감 자동화(`scripts/session-close.js`)가 없었을 때는 다음 세션에서 "어디까지 했더라?"를 파악하는 데 시간이 낭비됐다. 자동화 후 세션 복원 시간이 크게 줄었다.

### 2-2. 대화로 요구사항이 발견된다

기능 목록을 먼저 정의하지 않았다. **운영하면서 문제가 생기면 그게 요구사항이 됐다.**

예시:
- 운영 중 취소 예약이 자동 처리 안 됨 → `pickko-cancel.js` 개발
- 야간에 텔레그램 메시지가 안 와서 아침에 확인 → Heartbeat 추가
- 픽코에서 이름이 전화번호 뒤 4자리로 저장됨을 발견 → 이름 동기화 기능 추가
- 키오스크에서 직접 예약한 고객이 네이버로도 예약을 넣음 → 키오스크 모니터 추가

**"운영이 개발을 이끈다"** — 가장 큰 특징.

### 2-3. 인간이 결정하는 것, AI가 처리하는 것

| 인간이 결정 | AI가 처리 |
|------------|----------|
| OPS 전환 여부 | 코드 작성·수정 |
| 기능 우선순위 | 버그 분석·수정 |
| 테스트 대상 선정 | 리팩토링 |
| 운영 중 이슈 판단 | 문서 작성·갱신 |

인간은 **"무엇을 만들 것인가"와 "지금 배포해도 되는가"**를 판단한다. AI는 그 사이 모든 기술적 실행을 담당한다.

### 2-4. 컨텍스트 관리의 중요성

AI는 세션 간 기억이 없다. 이 문제를 시스템으로 해결했다:

- **BOOT.md** — 게이트웨이(봇) 시작 시 자동 주입되는 컨텍스트
- **CLAUDE_NOTES.md** — 클로드(개발자 AI)가 봇 AI에게 전달하는 행동 지침
- **memory/*.md** — 클로드 자신의 세션 간 메모리
- **session-close.js** — 세션 종료 시 히스토리 자동 기록

**발견:** BOOT 시간이 7분이었을 때 봇이 "느리다"는 불만이 생겼다. 파일을 읽는 방식에서 인라인으로 바꿔 54초로 줄였다. 컨텍스트를 어떻게 주입하느냐가 봇 사용성에 직결된다.

---

## 3. 주요 의사결정 기록 (Decision Log)

### DEC-001 | Playwright 선택 (네이티브 API 대신)

**배경:** 네이버 스마트플레이스와 픽코 키오스크 모두 공개 API가 없다.

**고려한 옵션:**
- A. 네이버 공식 API — 존재하지 않음 (파트너사 전용 비공개)
- B. 브라우저 자동화 (Playwright/Puppeteer) — 느리지만 실현 가능
- C. 역공학 (HTTP 직접 호출) — 가능하지만 유지보수 비용 높음

**선택:** B (Playwright)

**이유:** 빠르게 작동하는 프로토타입이 필요했다. 실제 브라우저를 사용하므로 UI 흐름을 따라가는 한 안정적이다.

**결과:** 6일 만에 완전 자동화 달성. 단점은 UI 변경에 취약하다는 것 — 장기 과제로 남겨둠.

---

### DEC-002 | OPS/DEV 모드 분리

**배경:** 개발 중 실수로 실제 고객 예약이 처리될 수 있다.

**고려한 옵션:**
- A. 별도 테스트 환경 — 픽코/네이버 계정이 하나뿐이라 불가
- B. 코드 내 모드 분기 — 화이트리스트 방식

**선택:** B (화이트리스트 방식)

**이유:** DEV 모드에서는 사장님·부사장님 전화번호만 처리한다. 실수할 여지가 없다.

**결과:** 개발-운영 전환이 명확해졌고, "OPS 전환"이 중요한 이정표가 됐다. 사장님과의 협의가 명시적으로 필요해져서 신뢰 구축에도 도움이 됐다.

---

### DEC-003 | 취소 감지: 카운터 → 리스트 비교 방식

**배경:** 네이버 예약 취소를 감지하는 방법이 필요했다.

**1차 구현:** 네이버 화면의 "취소 N건" 카운터를 읽어서 증가하면 처리
- **문제:** 카운터 파싱이 가끔 실패해서 0을 반환함 → 취소 미감지

**2차 구현:** 이전 확정 예약 목록 vs 현재 목록 비교 + 취소 탭 직접 방문
- **추가 방어:** `cancelledHref` 파싱 실패 시 폴백 URL로 취소 탭 방문

**교훈:** UI 요소 파싱은 실패할 수 있다. 항상 폴백 전략이 필요하다.

---

### DEC-004 | JSON → SQLite 마이그레이션 (2026-02-26)

**배경:** 상태 파일이 6개의 JSON으로 분산되어 있었다.
```
naver-seen.json, naver-seen-dev.json, pickko-kiosk-seen.json,
.pickko-alerts.jsonl, pending-telegrams.jsonl, cancelledSeenIds...
```

**문제:**
1. 원자적 쓰기가 어려워 파일 손상 위험 (프로세스 강제 종료 시)
2. 개인정보(전화번호, 이름)가 평문 저장
3. 쿼리가 불편함 (파일 전체 읽기 후 필터)
4. 백업 대상이 여러 파일

**선택:** SQLite 단일 파일 + AES-256-GCM 암호화

**이유:**
- WAL 모드로 동시성 안전
- `db_encryption_key`로 전화번호·이름 암호화
- 백업 대상: `state.db` + `secrets.json` 2개만
- macOS 맥미니 이전 시 복사가 단순해짐

**결과:** 마이그레이션 후 안정성 향상. 맥미니 이전 시 복사 대상 명확.

---

### DEC-005 | lib/ 공유 라이브러리 추출

**배경:** 4개의 src 파일에 동일한 코드가 반복됐다.
- 픽코 로그인 코드 4곳
- 비밀값 로딩 코드 4곳
- 시간 포맷팅 코드 여러 곳

**트리거:** 한 곳에서 버그를 고치면 다른 곳에 동일한 버그가 남아있는 상황이 반복됐다.

**선택:** lib/ 디렉토리로 추출 (utils/secrets/formatting/files/args/browser/pickko)

**결과:**
- 중복 코드 220줄 제거
- 이후 pickko-stats, pickko-query, pickko-cancel-cmd 등 신규 스크립트 개발 속도 향상
- `fetchPickkoEntries()` 같은 핵심 함수가 4개 스크립트에서 재활용

**패턴:** 중복이 3번 이상 발생하면 추출 타이밍. 미리 추상화하지 않는다.

---

### DEC-006 | 텔레그램 직접 호출 (OpenClaw 우회)

**배경:** 알림을 `openclaw agent --deliver` 명령으로 보내고 있었다.

**문제 발견:** 텔레그램으로 "Heartbeat OK" 같은 내용이 전송돼야 하는데, LLM이 메시지를 읽고 재해석해서 다른 내용으로 발송됨. 야간 보류 알림도 LLM을 거치면서 유실.

**선택:** `lib/telegram.js` 신규 — Telegram Bot API 직접 HTTP 호출

**이유:** 알림은 LLM 해석이 불필요하다. "이 텍스트를 그대로 보내라"는 것이 목적.

**결과:** 알림 내용이 100% 의도대로 전송됨. 재시도 로직(3회, 10초 타임아웃)으로 신뢰성 향상.

**교훈:** AI 게이트웨이가 모든 것을 처리하면 좋을 것 같지만, "그대로 실행"이 필요한 작업에는 직접 호출이 낫다.

---

### DEC-007 | 4-Tier Fallback (픽코 슬롯 선택)

**배경:** 픽코 시간표 슬롯 선택이 가끔 실패했다.

**원인 분석:** DOM 구조가 상황에 따라 달랐다.
- 회원 정보가 있을 때: `li[date][st_no][start][mb_no=""]`
- 특정 상태에서: 일부 속성 없음

**선택:** 4단계 폴백 체인
```
Method-1: li[date][st_no][start][mb_no=""]  (가장 엄격)
Method-2: li[date][st_no][start]
Method-3: li[st_no][start]
Method-4: li[start] 순회                    (최후 수단)
```

**결과:** 슬롯 선택 실패율 거의 0으로 감소.

**패턴:** 프로덕션 UI 자동화에서 단일 셀렉터에 의존하면 반드시 실패한다. 방어적 폴백 체인이 필수.

---

### DEC-008 | launchd 선택 (PM2 대신)

**배경:** 프로세스 스케줄링 도구가 필요했다.

**고려한 옵션:**
- A. PM2 — Node.js 생태계 표준, cron 지원
- B. macOS launchd — 시스템 네이티브, plist 설정

**선택:** launchd

**이유:**
- 이미 macOS 위에서 개발 중
- 추가 설치 불필요
- 시스템 부팅 시 자동 시작이 자연스럽게 처리됨
- plist 파일이 git에 포함되어 재현 가능

**결과:** 현재 7개 launchd 서비스 운영 중 (naver-monitor, log-report, pickko-verify 3회, daily-audit 2회, kiosk-monitor, daily-summary 2회)

**단점:** plist 문법이 verbose하다. 맥미니 이전 후 PM2 재검토 예정.

---

### DEC-009 | Heartbeat 설계 (알림 vs 침묵의 구분)

**배경:** 봇이 정상 작동 중인지, 아니면 조용히 죽어있는지 알 수 없었다.

**선택:** 30분(→1시간) 주기로 텔레그램에 생존 메시지 전송

**추가 설계:**
- 09:00~22:00만 전송 (야간 방해 방지)
- 야간 발생 알림은 `pending-telegrams.jsonl`에 저장 → 09:00 첫 Heartbeat 시 일괄 발송

**결과:** "아무 소식도 없는데 잘 되고 있는 건가?" 불안 해소. 모니터링의 기본.

---

### DEC-010 | AES-256-GCM 암호화 (개인정보 보호)

**배경:** SQLite 마이그레이션 시 전화번호, 이름이 DB에 평문 저장되는 문제.

**선택:** `lib/crypto.js` — Node.js 내장 `crypto` 모듈, AES-256-GCM

**이유:**
- 외부 의존성 없음 (Node.js 내장)
- 인증된 암호화 (복호화 시 무결성 검증)
- kiosk_blocks 테이블은 전화번호가 필요 없어서 SHA256 해시만 사용

**결과:** DB 파일이 유출돼도 전화번호·이름 노출 없음. 맥미니 이전 시 안전하게 복사 가능.

---

### DEC-011 | BOOT 최적화 전략 (7분 → 54초)

**배경:** OpenClaw 게이트웨이 재시작 시 봇이 현황을 파악하는 데 7분이 걸렸다.

**원인 분석:**
- BOOT.md에 여러 파일 읽기 지시 포함 (`--sync` 명령)
- LLM이 파일을 읽으면서 7번의 API 왕복 발생
- DEV_SUMMARY.md, HANDOFF.md 등 대용량 파일도 포함

**선택:** 핵심 컨텍스트(IDENTITY + MEMORY)를 BOOT.md에 인라인으로 포함

**변경 내용:**
- `--sync` 지시 제거
- DEV_SUMMARY/HANDOFF 참조 제거 (필요시 봇이 별도 요청)
- API 왕복: 7턴 → 2턴

**결과:** 54초 (2회 연속 검증). 사용성이 근본적으로 달라짐.

**교훈:** LLM 컨텍스트 주입 방식이 응답 속도에 결정적 영향을 준다. "필요할 때 읽기" < "처음부터 인라인".

---

### DEC-012 | packages/core 공유 인프라 설계

**배경:** 나중에 여러 봇을 추가할 계획이 있었다. 각 봇이 독립적으로 개발되면 또 중복이 생긴다.

**선택:** monorepo 구조
```
packages/
  core/           ← 모든 봇이 공유하는 유틸리티
  playwright-utils/ ← Playwright 헬퍼
bots/
  _template/      ← 새 봇 스캐폴딩
  reservation/    ← 스카봇
```

**이유:** 6일 경험으로 중복 코드의 비용을 실감했다. 두 번째 봇 추가 전에 기반을 만들어두는 것이 효율적.

**결과:** 아직 두 번째 봇은 없지만, 구조가 준비됨. `bots/_template`으로 새 봇 시작 시간 단축 기대.

---

### DEC-013 | 취소 자동화 플로우 재설계

**배경:** 첫 번째 취소 플로우 구현이 잘못된 방향으로 만들어졌다.

**1차 구현:** `input#sd_step-1` (취소 radio, value="-1") 직접 선택
- **문제:** 이것은 예약 수정 폼에서 취소 상태로 변경하는 것 → 결제 취소(환불)가 아님

**2차 구현 (올바른 플로우):**
```
상세보기 → 주문상세 버튼 → 결제항목 상세보기 → 환불 버튼 → 확인 팝업
```

**추가 발견:** 결제 상태에 따라 케이스가 달랐다:
- 결제완료 → 위 플로우
- 0원/이용중 → 주문상세 버튼 없음 → [6-B] 수정 폼 폴백
- 결제대기 → 주문상세 있지만 a.pay_view 없음 → [7-B] write 폼 폴백

**교훈:** "작동한다"와 "올바르게 작동한다"는 다르다. 프로덕션 데이터로 검증하기 전까지는 모른다.

---

### DEC-014 | 대화형 자연어 명령 설계

**배경:** 사장님이 봇에게 "오늘 예약 알려줘", "010-1234-5678 취소해줘" 같은 자연어로 명령하길 원했다.

**설계 방향:**
- 봇(LLM)이 자연어를 해석해서 CLI 명령으로 변환
- CLI는 stdout으로 JSON 반환 (`{ success, message, data }`)
- 봇이 JSON을 받아서 텔레그램에 친절한 메시지로 변환

**구현:**
- `pickko-register.js` — 예약 등록
- `pickko-cancel-cmd.js` — 예약 취소
- `pickko-query.js` — 예약 조회
- `pickko-stats-cmd.js` — 매출 통계
- `pickko-ticket.js` — 이용권 추가

**검증:** `test-nlp-e2e.js` 27케이스 E2E 테스트 100% 통과

**교훈:** LLM과 CLI의 분리가 핵심. LLM은 "무엇을 할지" 판단하고, CLI는 "어떻게 할지" 실행한다. 이 경계를 명확히 하면 각각을 독립적으로 테스트할 수 있다.

---

### DEC-015 | 세션 마감 자동화

**배경:** 세션 종료 전에 문서를 업데이트하는 것을 자주 잊었다. 다음 세션에서 "어디까지 했지?"를 파악하는 데 시간이 걸렸다.

**선택:** `scripts/session-close.js` — 세션 마감을 CLI 하나로 처리

```bash
node scripts/session-close.js \
  --bot=reservation \
  --title="기능명" \
  --type=feature \
  --items="항목A|항목B" \
  --files="a.js|b.js"
```

**자동 처리 내용:**
- HANDOFF.md에 마감 블록 추가
- DEV_SUMMARY.md 타임라인 항목 추가
- BOOT.md 재생성
- OpenClaw 배포

**결과:** 세션 마감이 "번거로운 일"에서 "버튼 하나"가 됐다. 히스토리 기록 누락이 거의 없어졌다.

---

## 4. 아키텍처 진화

### Phase 1 | 단일 파일 (2026-02-22)

```
naver-monitor.js (모든 것 포함)
  └─ 픽코 로그인
  └─ 예약 파싱
  └─ 픽코 등록 (inline)
  └─ 알림
```

**문제:** 한 파일이 너무 커지고, 취소 로직을 추가할 공간이 없었다.

---

### Phase 2 | 기능별 분리 (2026-02-22~23)

```
naver-monitor.js  ← 감지 + 오케스트레이션
pickko-accurate.js ← 등록
pickko-cancel.js   ← 취소 (신규)
```

---

### Phase 3 | 공유 라이브러리 추출 (2026-02-24)

```
naver-monitor.js
pickko-accurate.js
pickko-cancel.js
pickko-verify.js   ← 신규
lib/               ← 신규
  utils.js, secrets.js, formatting.js,
  files.js, args.js, browser.js, pickko.js
```

---

### Phase 4 | 전문화된 스크립트 추가 (2026-02-25~26)

```
src/
  naver-monitor.js, pickko-accurate.js, pickko-cancel.js
  pickko-verify.js, pickko-daily-audit.js
  pickko-kiosk-monitor.js          ← 신규 (키오스크 모니터)
  pickko-daily-summary.js          ← 신규 (일일 요약)
  pickko-register.js, pickko-cancel-cmd.js  ← NLP 명령
  pickko-query.js, pickko-stats-cmd.js      ← NLP 명령
  pickko-ticket.js, pickko-member.js        ← NLP 명령
lib/
  (기존 7개 + crypto.js, db.js, telegram.js, pickko-stats.js, cli.js)
```

---

### Phase 5 | 멀티봇 인프라 (2026-02-27)

```
packages/
  core/             ← 모든 봇 공유
  playwright-utils/ ← Playwright 헬퍼
bots/
  _template/        ← 새 봇 스캐폴딩
  reservation/      ← 스카봇 (Phase 4 구조)
    src/, lib/, scripts/, context/
```

---

## 5. AI 협업 패턴 분석

### 잘 작동한 패턴

**① 운영 중 버그 → 즉각 수정**
- 실제 운영 중 발견한 버그는 맥락이 명확해서 수정이 빠르다
- "정진영 씨 예약이 중복으로 들어왔어요" → 원인 분석 → 수정 → 재배포 흐름이 1세션에서 끝났다

**② 작은 단계씩 검증**
- 한 번에 큰 변경을 하지 않았다
- pickko-cancel.js를 만들 때: 로그인 → 목록 조회 → 단건 취소 → 폴백 추가 → OPS 활성화 순서

**③ 테스트 예약으로 안전망 확보**
- 이재룡(사장님) 번호로 테스트 예약 → 정상 확인 → OPS 적용
- 실수가 나도 테스트 계정 데이터만 영향

**④ stdout JSON 컨벤션**
- CLI 스크립트가 모두 `{ success, message, data }` JSON을 stdout으로 반환
- LLM이 쉽게 결과를 파싱하고 자연어로 변환 가능
- 사람이 직접 실행해도 읽을 수 있음

### 어려웠던 부분

**① DOM 구조 파악**
- 픽코, 네이버 모두 비공개 서비스 → 직접 브라우저로 탐색해서 셀렉터를 찾아야 함
- 한 번 찾아도 다른 상태에서 DOM이 달라서 폴백이 필요

**② 세션 간 컨텍스트 손실**
- BOOT 최적화 전: 매 세션 시작에 5~7분 소요
- 해결책: BOOT.md 인라인 컨텍스트

**③ LLM의 창의적(?) 재해석**
- 텔레그램 알림을 openclaw로 보냈을 때 LLM이 내용을 재해석
- 해결책: 텔레그램 직접 호출로 LLM 우회

---

## 6. 주요 교훈

### 개발 방법론

1. **운영이 개발을 이끈다** — 사용해보기 전엔 무엇이 필요한지 모른다
2. **작은 단계가 큰 성과** — 하루에 1~2개 기능만 완전히 완성하는 것이 낫다
3. **중복이 3번 나오면 추출** — 미리 추상화하지 않는다
4. **폴백은 반드시 있어야 한다** — 프로덕션 UI는 항상 예외 상황이 존재한다

### AI 협업

5. **컨텍스트 관리가 생산성의 핵심** — AI는 기억이 없다. 이것을 시스템으로 해결해야 한다
6. **AI에게 "실행"을 맡기되 "판단"은 인간이** — OPS 전환, 고객 데이터 처리 결정은 항상 인간이 한다
7. **CLI + LLM 분리** — CLI는 결정론적으로, LLM은 해석에만 사용한다
8. **stdout JSON 컨벤션** — LLM-CLI 인터페이스의 표준화가 전체 시스템을 단순하게 만든다

### 인프라

9. **암호화는 처음부터** — 나중에 추가하면 마이그레이션 비용이 크다
10. **BOOT 시간이 UX다** — LLM 응답 속도만이 아니라 시작 시간도 중요하다

---

## 7. 다음 연구 과제

- [ ] 세션 대화 로그 샘플 수집 및 패턴 분류
- [ ] "한 세션에서 해결 가능한 문제의 크기" 연구
- [ ] BOOT.md 컨텍스트 최적화 실험 (얼마나 적으면 충분한가?)
- [ ] 자연어 명령 해석 정확도 측정 방법론
- [ ] 멀티봇 환경에서의 컨텍스트 분리 전략

---

## 8. 루나팀 구축기 — 암호화폐 + 국내주식 자동매매 (2026-03-01~)

### 배경

스카팀(스터디카페)이 안정화되면서 자연스럽게 다음 질문이 나왔다: **AI로 투자도 자동화할 수 있을까?** 단순한 기술 호기심이었지만, 실계좌 자산이 걸려 있으니 스카팀과는 완전히 다른 설계 원칙이 필요했다.

핵심 제약: **"잘못 실행하면 돈이 날아간다."**

### Phase 0: 드라이런 우선 원칙

스카팀에서 배운 교훈 중 하나는 "OPS를 빨리 배포하려는 욕심이 버그를 만든다"는 것이었다. 루나팀은 처음부터 DEV/OPS 분리를 코드 레벨에서 강제했다.

```
DEV  (기본): dry_run=true  — 주문 없음, DB+텔레그램만
OPS  (실거래): INVEST_MODE=ops + dry_run=false + API 키 5개 + 다중 가드
```

`lib/mode.js`의 `guardRealOrder()`는 DEV 환경에서 실수로 실주문을 보내는 것을 코드 수준에서 차단한다. `assertOpsReady()`는 OPS 진입 전 5가지 조건을 체크한다.

### 설계 결정 1: 심볼 네임스페이스 분리

코인과 국내주식을 같은 DB에서 관리할 때 가장 먼저 고민한 것은 **심볼 충돌** 문제였다. 결론은 단순했다.

```js
// 코인:    'BTC/USDT', 'ETH/USDT'  — 슬래시 포함
// 국내주식: '005930', '000660'      — 6자리 숫자만
isKisSymbol(symbol) = /^\d{6}$/.test(symbol)
```

두 포맷이 구조적으로 겹칠 수 없어서 별도 파싱 없이 구분이 가능하다. 단순함이 가장 좋은 해결책이었다.

### 설계 결정 2: amount_usdt 필드 재사용

DB 스키마에 `amount_usdt` 컬럼이 이미 있었다. KIS(국내주식)용으로 `amount_krw`를 별도로 추가하면 스키마가 복잡해진다. 대신 `amount_usdt` 필드를 KRW 금액으로 재사용하되 **주석으로 명시**하는 방법을 택했다.

```js
// amount_usdt 필드를 KRW 금액으로 재사용 (DB 컬럼 네이밍 불일치 — KIS는 KRW)
totalUsdt: order.totalKrw,
```

Migration v2에서 `exchange` 컬럼('binance'/'kis')을 추가해 거래소 구분은 명확히 했다. 이 결정은 "지금 당장 필요한 최소한의 변경"이라는 원칙에 따른 것이다.

### 설계 결정 3: 리스크 매니저 분리

기존 `risk-manager.js`는 USDT 기준으로 설계되어 있어 KRW 거래에 직접 재사용할 수 없었다. 두 가지 선택지가 있었다:

1. risk-manager.js를 멀티 커런시로 리팩토링
2. kis-executor.js에 인라인 리스크 규칙 삽입

현재 KIS 봇 하나뿐이라 추상화 레이어를 만들 이유가 없다. **2번(인라인)** 선택.

```js
const KIS_RULES = {
  MIN_ORDER_KRW:      10_000,
  MAX_ORDER_KRW:   5_000_000,
  MAX_DAILY_LOSS_PCT:    0.05,
};
```

"세 번 반복되면 추출한다"는 원칙에 따라, KIS 봇이 늘어나면 그때 공통 모듈로 분리한다.

### 한국투자증권(KIS) API 선택 이유

| 항목 | 내용 |
|------|------|
| **실시간 데이터** | WebSocket 기반 실시간 체결가·호가 스트림 (Phase 2 도입 예정) |
| **문서화** | 공식 API 문서 체계적 정비, Python/JS 예시 코드 제공 |
| **모의투자** | `openapivts.koreainvestment.com` — 실계좌 없이 동일 환경 테스트 |
| **접근성** | 한투증권 계좌 개설만으로 무료 발급, IP 화이트리스트 등록 필수 |
| **Phase 1** | REST API (현재가·OHLCV·주문·잔고), `kis_paper_trading: true` 기본값 |
| **Phase 2** | WebSocket 체결가 스트림 → 제이슨 실시간 신호 확장 예정 |

### LLM 전략: Claude → Groq 전환 로드맵

```
Phase 1~2 (지금): Claude Sonnet 4.6 — 맥북으로 신호 판단 LLM 전담
Phase 3 (맥미니): Groq llama-3.3-70b-versatile — 3× 빠름, 무료
```

맥미니 이전 전까지는 Claude가 코인+국내주식 양쪽 신호 판단을 모두 담당한다. KIS 전용 프롬프트(`SYSTEM_PROMPT_KIS`)를 분리해서 원화 기준·국내 시장 특성(가격제한폭 ±30%, 장 시간 제한)을 반영했다.

### 교훈: "모의투자 모드가 OPS 설계를 강제한다"

KIS `kis_paper_trading: true`를 기본값으로 설정한 것처럼, **안전 상태가 기본값**이 되어야 한다. 실전 전환은 사용자가 명시적으로 설정을 바꿔야만 가능하도록 했다. 스카팀의 `dry_run: true` 기본값과 동일한 원칙이다.

잘못된 설계: "실전이 기본, 테스트할 때만 플래그"
올바른 설계: "안전이 기본, 실전 진입은 명시적 승인"

_작성: 2026-03-01_

---

## 9. 루나팀 Phase 3-A v2.1 — 신규 아키텍처 설계기 (2026-03-02)

### 배경

기존 `bots/invest/` (루나팀 Phase 0)는 단일 사이클, CJS(require), 단일 LLM(Claude Sonnet)으로 동작했다. Phase 3-A에서는 3시장 분리(암호화폐/국내/해외), 12명 에이전트 팀, 다중 LLM 프로바이더, 비용 최적화를 목표로 완전 재설계했다. 기존 시스템을 건드리지 않기 위해 `bots/investment/` 신규 디렉토리를 별도로 생성했다.

---

### DEC-016 | ESM-first 모듈 시스템 선택

**배경:** 기존 `bots/invest/`는 CJS(`require`)로 작성됐다. Phase 3-A를 새로 만들 때 모듈 시스템을 결정해야 했다.

**고려한 옵션:**
- A. CJS 유지 — 기존 패턴, `require.main === module`, 익숙한 환경
- B. ESM 전환 — `import`/`export`, top-level await, ccxt/최신 패키지 요구

**선택:** B (ESM, `"type":"module"` in package.json)

**이유:**
- `ccxt`가 ESM first로 전환 중 — CJS 환경에서 dynamic import 문제 발생
- top-level await로 CLI entry point 코드가 단순해짐
- Node.js v24 환경, 최신 패키지들 ESM 권장

**발생한 문제와 해결:**
- `require('ccxt')` → top-level `import ccxt from 'ccxt'` 이동 필수 (함수 내 lazy require 불가)
- `require.main === module` → `process.argv[1] === fileURLToPath(import.meta.url)`
- 레거시 CJS 모듈 로드 필요 시(`../../invest/lib/kis.js`): `createRequire(import.meta.url)` 사용

**결과:** 20개 파일 전체 `node --check` 통과, dynamic import 오류 없음.

---

### DEC-017 | callLLM 통합 함수 + PAPER/LIVE 분기

**배경:** Phase 0에서는 LLM이 Claude Sonnet 단일이었다. Phase 3-A에서는 비용 최적화를 위해 에이전트별로 다른 모델을 써야 했다.

**설계:**
```js
// shared/llm-client.js
const HAIKU_AGENTS = new Set(['luna', 'nemesis']);

async function callLLM(agentName, systemPrompt, userMessage, maxTokens = 512) {
  if (isPaperMode()) {
    return callGroq(systemPrompt, userMessage, maxTokens);  // 전원 Groq Scout
  }
  if (HAIKU_AGENTS.has(agentName)) {
    return callHaiku(systemPrompt, userMessage, maxTokens); // 판단 전담: Haiku 4.5
  }
  return callGroq(systemPrompt, userMessage, maxTokens);    // 나머지: Groq Scout
}
```

**결정 근거:**
- **PAPER_MODE=true**: 시뮬레이션 — 비용 절약이 최우선. 전원 Groq(무료)로도 신호 품질 검증 가능
- **LIVE luna/nemesis**: 최종 투자 판단·리스크 평가 — 품질 중요. Haiku 4.5 사용
- **나머지 에이전트**: TA계산/뉴스요약/감성분류 — 속도 중요. Groq Scout(무료, 최고속)

**결과:** PAPER_MODE 시 LLM 비용 $0/일. LIVE 시 하루 예상 비용 Haiku $0.05~0.10 수준.

---

### DEC-018 | 30분 throttle과 launchd 주기 분리

**배경:** 사이클 주기를 어떻게 구현할지 결정해야 했다.

**옵션:**
- A. launchd plist StartInterval=1800 (30분) — 간단하지만 긴급 트리거 불가
- B. launchd plist StartInterval=300 (5분) + 내부 상태 파일로 30분 throttle

**선택:** B

**이유:**
- BTC ±3% 급등락 시 30분 기다리지 않고 즉시 사이클 실행 필요 (긴급 트리거)
- launchd 자체는 정각 주기가 아니라 "5분 뒤 다시 확인"만 담당
- 상태 파일 `~/.openclaw/investment-state.json`에 `lastCycleAt` + `lastBtcPrice` 저장

```js
async function shouldRunCycle(symbols) {
  if (now - state.lastCycleAt >= CYCLE_INTERVAL) return { run: true, reason: '30분 정규 사이클' };
  const btcPriceChange = Math.abs((currentPrice - state.lastBtcPrice) / state.lastBtcPrice);
  if (btcPriceChange >= 0.03) return { run: true, emergency: true, reason: 'BTC 긴급 트리거' };
  return { run: false };
}
```

**결과:** 평상시 30분 주기 + BTC 급변 시 즉시 대응 가능. `--force` 플래그로 테스트 시 throttle 우회.

---

### DEC-019 | BUDGET_EXCEEDED EventEmitter — 비용 초과 즉시 중단

**배경:** LLM API를 여러 에이전트가 병렬로 호출하면 예상 외 비용이 발생할 수 있다.

**설계:**
```js
// shared/cost-tracker.js — EventEmitter 패턴
tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  await sendTelegram(`💸 ${label} LLM 예산 초과 — 사이클 중단`);
  process.exit(1);
});
```

**결정 근거:**
- LLM 호출 전 매번 예산 확인보다 이벤트 리스너가 비침투적(non-invasive)
- `once`를 사용해 중복 실행 방지
- 텔레그램 알림 후 즉시 `process.exit(1)` — 현재 사이클만 중단, 다음 실행에는 영향 없음

**한계:** 이미 시작된 병렬 호출은 중단 불가. 허용 오버런이 발생할 수 있으나 1 사이클 분량이라 수용 가능 수준.

_작성: 2026-03-02_

---

---

### DEC-020 | DuckDB WAL 재생 버그 — CHECKPOINT로 해결

**배경:** DuckDB 1.4.4에서 `ALTER TABLE ... ADD COLUMN` DDL이 WAL에 기록된 후, 다음 세션에서 WAL 재생 시 내부 오류 발생.

**증상:**
```
[Error: INTERNAL Error: Failure while replaying WAL file:
Calling DatabaseManager::GetDefaultDatabase with no default database set]
```

**원인 분석:**
- `initSchema()` 에서 `ALTER TABLE signals ADD COLUMN trace_id VARCHAR` 실행 → WAL에 기록됨
- 프로세스 정상 종료 전 WAL이 메인 DB로 플러시되지 않은 채 남음
- 다음 오픈 시 DuckDB가 WAL을 재생하려 하지만 Catalog 초기화 타이밍 문제로 실패

**해결:**
```js
// shared/db.js — initSchema() 마지막에 추가
try { await run('CHECKPOINT'); } catch { /* 무시 */ }
```
`CHECKPOINT` 명령으로 WAL → 메인 DB 즉시 플러시 → 다음 오픈 시 WAL 없음

**교훈:** DuckDB를 단기 실행 프로세스(launchd)에서 사용할 때 DDL 후 반드시 CHECKPOINT 또는 명시적 `db.close()` 필요.

_작성: 2026-03-04_

---

### DEC-021 | LLM 정책 v2.2 — Groq 전용 (LIVE 모드에서도 무료)

**배경:** 초기 설계(v2.1)는 LIVE 모드에서 luna·nemesis에 Claude Haiku를 사용하는 정책이었으나, 실운영 중 예산 초과 및 사용자 비용 부담 문제가 제기됨.

**검토:**
- Haiku 비용: LIVE 30분 사이클 4심볼 기준 약 $3~5/월
- Groq llama-4-scout: 무료, 속도 충분 (6~12초/사이클)
- LIVE 모드의 핵심 가치는 "실주문 여부"이지 "더 비싼 LLM" 사용 여부가 아님

**결정:**
```js
// shared/llm-client.js
// HAIKU_AGENTS 제거 → 전 모드 Groq 전용
export async function callLLM(agentName, systemPrompt, userPrompt, maxTokens = 512) {
  // Groq Scout 라운드로빈만 실행 (Haiku 분기 삭제)
}
```

**결과:** LLM 비용 $0/월 유지하면서 LIVE 실거래 운영 가능. 향후 정확도 차이가 체감되면 재검토.

_작성: 2026-03-04_

---

### DEC-022 | Claude Remote Control 세션 폭발 사고 — 아키텍처 교훈

**사건:** `cc-remote-start.sh` (while true 루프)가 launchd에 등록되어 부팅부터 실행 중. `claude remote-control` 명령이 내부적으로 `--sdk-url <session_id>` 를 Node.js 플래그로 전달하는 버그로 즉시 실패 → 10초 후 재시작 → 2,407개 세션 생성.

**근본 원인:** `claude remote-control`이 아직 불안정한 실험적 기능. 자동 재시작 루프와 결합 시 폭발적 증식.

**대응:** 해당 launchd 에이전트·스크립트 전체 삭제. tmux, Termius 관련 인프라도 함께 제거.

**설계 교훈:**
1. 실험적 CLI 기능을 launchd 자동 재시작 루프에 넣지 말 것
2. 새 외부 도구 통합 시 먼저 수동 검증 → 안정화 확인 후 자동화
3. while true 루프는 반드시 성공 판정 후 재시작 조건 명시 (예: 종료 코드 확인)

_작성: 2026-03-04_

---

---

### DEC-023 | LLM 명칭 일반화 — "제이는 항상 Gemini가 아니다"

**배경:** intent-parser.js에 `parseGemini`, `GEMINI_MODEL`, `groqResult`, `source: 'gemini'` 등 특정 LLM 이름이 하드코딩되어 있었음. 사용자가 지적: "LLM API는 속도·성능에 따라 달라질 수 있는데 Gemini로 작성하는 건 오류."

**결정:**
- `parseGemini` → `parseLLMFallback`
- `GEMINI_MODEL / GEMINI_PROVIDER` → `LLM_FALLBACK_MODEL / LLM_FALLBACK_PROVIDER`
- `groqResult` → `llmResult`, `source: 'gemini'` → `source: 'llm'`
- 실제 모델값은 두 상수에만 격리 → 교체 시 두 줄 수정으로 완료

**교훈:** 특정 벤더/모델 이름을 코드 전반에 퍼뜨리지 말 것. 추상화 상수 1~2개에만 격리.

_작성: 2026-03-04_

---

### DEC-024 | NLP 자동개선 루프 — "배우는 제이"

**설계 문제:** 제이가 이해하지 못하는 명령에 "명령을 이해하지 못했습니다"만 반환하면 영구적으로 개선되지 않는다.

**해결:**
1. `router.js` default case → `analyze_unknown` bot_command 발행
2. `claude-commander.js` `handleAnalyzeUnknown()`: `claude -p` headless 실행
   - 구조화된 프롬프트(전체 인텐트 목록 + 예시 포함) → JSON 응답
   - 응답: `user_response` (사용자에게 전달) + `pattern` (학습할 regex)
3. `saveLearning()`: regex 유효성 검증 후 `nlp-learnings.json`에 저장 (중복 방지)
4. `intent-parser.js`: 5분마다 JSON 리로드, `_learnedPatterns` 배열을 keyword 앞에서 먼저 체크

**장점:** 코드 수정 없이 런타임 학습. 잘못된 패턴도 JSON에서 직접 삭제 가능. LLM 교체 시 학습 데이터 그대로 유지.

**한계:** Claude가 제안한 regex가 너무 광범위하면 오탐 가능. 향후 confidence score 추가 고려.

_작성: 2026-03-04_

---

### DEC-025 | 봇 정체성 유지 — LLM 없이 역할 망각 방지

**문제 정의:** 봇이 자신의 역할과 임무를 "망각"하는 현상. LLM 기반 시스템은 컨텍스트가 초기화되면 페르소나가 사라짐. 파일 기반 봇도 코드가 없으면 자신이 무엇인지 모름.

**최종 목표 (사용자 명시):** "각 팀장과 팀원들이 본인의 역할과 임무를 망각하지 않고 지속 수행하는 것."

**3계층 구조로 설계:**

| 계층 | 담당 | 주기 | 방식 |
|------|------|------|------|
| 제이 | 3개 팀장 정체성 점검 | 6시간 | `identity-checker.js` — COMMANDER_IDENTITY.md 존재 + 필수 섹션 확인, 없으면 템플릿으로 자동 복원 |
| 각 팀장 | 자신의 팀원 정체성 점검 | 6시간 | `bot-identities/[id].json` 생성·갱신 (name/role/mission/llm) |
| 각 커맨더 자신 | 자신의 역할 능동 확인 | 시작+6시간 | `BOT_IDENTITY` 하드코드 기본값 + `loadBotIdentity()` — COMMANDER_IDENTITY.md에서 역할/임무 파싱 |

**LLM 없이 작동하는 이유:**
- `BOT_IDENTITY` 하드코드 기본값: 파일 없어도 역할 유지
- 파일 기반 로딩: 외부 API 불필요
- 향후 LLM 연동 시 `BOT_IDENTITY.role + mission`을 시스템 프롬프트에 주입하면 됨 (확장 포인트 확보)

_작성: 2026-03-04_

---

### DEC-026 | 제이↔클로드 직접 통신 채널

**필요성:** 사용자가 Telegram에서 복잡한 질문(루나팀 전략 분석, 코드 리뷰 등)을 했을 때 제이(NLP 봇)가 직접 답하는 데는 한계가 있음. Claude Code의 전체 프로젝트 컨텍스트가 필요한 작업은 Claude Code가 직접 처리해야 함.

**구현:**
- 트리거: `/claude <질문>` 또는 `/ask <질문>` 슬래시 명령
- 경로: intent-parser `claude_ask` → router `ask_claude` bot_command → claude-commander `handleAskClaude()`
- 실행: `spawnSync('claude', ['-p', query, '--dangerously-skip-permissions'], { cwd: PROJECT_ROOT })`
- 제한: 응답 3500자 (Telegram 4096자 - 여유), 타임아웃 280초 (5분 - 20초 여유)

**트레이드오프:**
- `--dangerously-skip-permissions`: 자동 승인 필요 (claude-commander가 백그라운드 데몬이므로 대화형 불가)
- PROJECT_ROOT에서 실행: 전체 프로젝트 CLAUDE.md + 메모리 컨텍스트 로드됨
- headless 모드: 응답이 순수 텍스트로 반환됨 (마크다운 렌더링 없음)

_작성: 2026-03-04_

---

_최초 작성: 2026-02-27 | 작성자: 클로드 (Claude Code) + 사용자_

### 2026-03-11~15 — 대규모 안정화 + 신규 기능

핵심 결정:
- 워커팀 v2 피벗: 폼 기반 → 자연어 대화 기반
- 웹 대시보드 UI: Claude Code 채팅 + 동적 캔버스 패턴 채택
- 실시간 통신: SSE → XHR+onprogress (모바일 Chrome 버퍼링 우회)
- 동적 렌더링: Claude Code 응답 → 15종 UI 컴포넌트 자동 매칭
- DB 전략: Phase 1~3 RAG 불필요, Phase 4+ RAG 도입
- 인프라: 로컬 IP 접속 → 추후 Cloudflare Tunnel
- KST 유틸리티 중앙화로 UTC/KST 변환 실수 근절

인사이트:
- 클로드코드 채팅 메시지 분할 문제: tool_use 이벤트 사이에 새 assistant 텍스트가 오면 새 버블을 생성하는 버그. 수정: 역방향으로 마지막 streaming assistant 버블 찾아서 병합
- 제이 인텐트 자동 프로모션 = 봇이 스스로 학습하는 구조
- 통합 OPS 헬스 = 마스터가 한눈에 전체 시스템 파악 가능
- file-guard.js = 봇의 소스코드 수정 물리적 차단
- launchd StartCalendarInterval = 로컬시간(KST) 기준, UTC 변환 절대 금지 (확인된 실수 패턴)

_작성: 2026-03-15_

---
