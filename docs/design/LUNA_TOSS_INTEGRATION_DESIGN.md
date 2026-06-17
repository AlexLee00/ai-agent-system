# 루나팀 — 토스증권 Open API 통합 설계 (보강 설계서)

> v0.1 (2026-06-13) · 작성: 메티 · 상위 SSOT=LUNA_OPTIMAL_REDESIGN.md(v1.3) · 본서=토스 적용 증분 설계(C18 신설 + C1/C3/C4/C7/C14/C15/C16 보강)
> 근거: 토스증권 공식 Open API 가이드(developers.tossinvest.com, 2026-06) 정밀 분석 + 기존 KIS 연동·secrets·MCP/A2A/스킬 실측
> 원칙(불변): 무중단(PROTECTED·crypto LIVE·스카) · **전부 shadow 우선 → C15 자동승급 경로로만 LIVE 승격** · 마스터=게이트 · 과거 기록 불변

---

## 0. 토스 API 표면 분석 (공식 가이드 기준)

### 0-1. 인증·기반
- **OAuth 2.0 Client Credentials Grant** — 공식 OpenAPI 1.1.1 기준 `POST /oauth2/token`에 `application/x-www-form-urlencoded` body(`grant_type=client_credentials`, `client_id`, `client_secret`)를 전송 → `{access_token, token_type, expires_in}`. 이후 `Authorization: Bearer {token}`. 계좌·자산·주문 엔드포인트는 `X-Tossinvest-Account` 헤더 추가.
- Base URL: `https://openapi.tossinvest.com` · 응답 전부 JSON · OpenAPI JSON 스펙 `/openapi-docs/latest/openapi.json`(자동 SDK 가능).
- 토큰 만료는 `expires_in` 응답 기준 → **50분 또는 expires_in*0.83 중 짧은 값으로 캐싱 갱신**(rate limit 보호).

### 0-2. 카테고리 6종 → 엔드포인트
| 카테고리 | 엔드포인트 | 루나 적용 |
|---|---|---|
| **Market Data** | `/api/v1/orderbook`, `/api/v1/prices`, `/api/v1/trades`, `/api/v1/price-limits`, `/api/v1/candles` | C1 게이트·C2 레짐·C7 백테스트 **데이터 소스**(KIS 병행/대체) |
| **Stock Info** | `/api/v1/stocks`, `/api/v1/stocks/{symbol}/warnings` | C14 종목 마스터·**투자유의 종목 필터**(유니버스) |
| **Market Info** | `/api/v1/exchange-rate`, `/api/v1/market-calendar/KR`, `/api/v1/market-calendar/US` | G0 휴장일 게이트·FX(미국주식 평가)·시장시간 |
| **Account/Asset** | `/api/v1/accounts`, `/api/v1/holdings` | C9 포지션·C16 보유 재평가 **실잔고 소스** |
| **Order** | `POST /api/v1/orders`, `POST /api/v1/orders/{orderId}/modify`, `POST /api/v1/orders/{orderId}/cancel`, `/api/v1/{buying-power,sellable-quantity,commissions}` | **C4 프리플라이트 외부 진실 검증** + LIVE 실행(승격 후) |
| **Auth** | `/oauth2/token` | C18 토큰 매니저 |

### 0-3. KIS 대비 차이 → 프로세스 영향 (정밀 검토 결과)
| 항목 | 토스 | 기존 KIS | 루나 프로세스 변경점 |
|---|---|---|---|
| 인증 | OAuth2 표준 | 커스텀 appkey+approval | C18 클라이언트가 **표준 OAuth로 단순화** — KIS approval-key 댄스 불필요 |
| **주문 사전검증** | buying-power·sellable·commission **3종 API** | 부분 제공 | 🔴 **C4 프리플라이트 G-liquidity/G-rr를 외부 진실로 교차검증** — 우리 추정 vs 토스 실제 비교 = 프리플라이트 정확도 향상 |
| 투자유의 종목 | `securities-warning` 전용 API | 별도 조회 | 🔴 **유니버스 필터에 신설 게이트** — 관리·환기·투자유의 종목 자동 배제 |
| 수수료 | **국내 무료**(2026.6까지, 이후 KRX 0.015%/NXT 0.014%) | 유료 | 🟡 **백테스트 비용 모델 보정**(C7) — 현 비용 가정이 과대평가일 수 있음 |
| 실시간 | REST 폴링(WS 미공개) | WS 일부 | 우리 30분 주기와 정합 — 변경 없음. 단 `/candles` 폴링 일원화 가능 |
| **Sandbox** | **없음**(실거래만) | paper 계좌 있음 | 🔴 **shadow→자동승급 설계가 결정적** — 토스는 모의 환경이 없으므로 shadow에서 충분히 검증 후 소액 LIVE 승격 필수 |
| 시장 범위 | KRX+미국 통합 | 국내/해외 분리 | C1 세그먼트(domestic/overseas)를 **단일 브로커로 커버** 가능 |

---

## C18. 브로커 추상화 계층 [신설 — 토스 통합 핵심]

> 목적: KIS·토스를 **단일 인터페이스 뒤로 추상화** → 데이터 소스·실행 브로커를 구성으로 전환. shadow는 브로커 무관, LIVE만 브로커 선택.

### C18-1. BrokerAdapter 인터페이스 (`bots/investment/shared/brokers/broker-adapter.ts`)
```
interface BrokerAdapter {
  // 읽기(shadow·LIVE 공통)
  getQuote(symbol, market): Quote
  getCandles(symbol, interval, range): Bar[]
  getOrderbook(symbol): Orderbook
  getHoldings(account): Holding[]
  getSecuritiesWarning(): WarnedSymbol[]   // 토스 전용 강점
  getMarketCalendar(market): Calendar
  getExchangeRate(): FxRate
  // 사전검증(C4 정합 — 외부 진실)
  getBuyingPower(account): Money
  getSellable(account, symbol): Qty
  getCommission(order): Money
  // 실행(LIVE 전용 — shadow에선 호출 금지)
  placeOrder(order): OrderResult       // capability-gated
  amendOrder(id, patch): OrderResult
  cancelOrder(id): OrderResult
  // 메타
  readonly name: 'toss'|'kis'|'binance'
  readonly capabilities: { canTrade, hasSecuritiesWarning, hasSandbox, markets[] }
}
```
- **TossAdapter**(신설) · **KisAdapter**(기존 kis-client 래핑) · 선택=구성(`broker.config.ts`). 기본 데이터 소스=토스(신뢰도·이용자 多), KIS=폴백.
- **capability 게이팅**: `placeOrder`는 `capabilities.canTrade && LIVE_TRADING_ENABLED && 승격완료` 3중 조건. shadow 모드에선 어댑터의 실행 메서드 자체가 차단(throw)·호출 경로 없음.

### C18-2. 토스 클라이언트 (`bots/investment/shared/brokers/toss-client.ts`)
- OAuth2 토큰 매니저(공식 form body 방식·50분 캐싱·만료 갱신)·rate limit 백오프(응답 헤더 `Retry-After`, `X-RateLimit-*` 기준 — 카테고리별 분리 큐, kis-client의 `resolveKisLane` 패턴 재사용).
- 결측 내성·재시도·표준 에러 코드 로깅(가이드 권고). 응답 정규화(우리 내부 Quote/Bar 스키마로).
- **읽기 전용 우선 구현** — placeOrder 등 실행 메서드는 capability OFF 기본, 구현은 하되 호출 차단.

### C18-3. MCP/A2A/스킬/훅 보강
- **MCP**: 기존 `luna-marketdata-mcp`에 토스 도구 추가(`toss-price`·`toss-candles`·`toss-orderbook`·`toss-securities-warning`) — KIS WS 도구와 병행. `luna-fx-mcp`에 토스 환율 소스 추가. **신규 MCP 서버 신설 금지**(기존 재사용 원칙).
- **A2A 스킬**: `bots/investment/a2a/skills/`에 `toss-account-snapshot`(잔고 조회 advisory)·`toss-preflight-verify`(C4 외부 검증 — buying-power/sellable/commission 대조). 전부 advisory/shadow.
- **스킬**: `bots/investment/skills/`에 토스 데이터 조회 스킬(회의실 grill·분석에서 호출 가능).
- **훅**: `luna-hooks`에 `toss-order-preflight-hook`(LIVE 주문 직전 토스 사전검증 3종 강제 — 승격 후 활성). shadow 단계엔 advisory 로깅만.

---

## C18-4. 시크릿 관리 — secret-store.md + 마스터 전용 입력 [요구사항 4]

> 목적: 토스 API 키를 **마스터만 입력**, 코드/git에 노출 0. 기존 `secrets.json`(gitignore) 패턴 확장 + 안내 문서.

### 설계
- **`docs/secret-store.md`**(신규, gitignore): 마스터가 채울 키 명세 + 입력 위치 안내만 담음(값 아님 — 플레이스홀더). 실제 값은 `secrets.json`(기존 gitignore 대상)에 입력.
- **`secrets.example.json` 확장**: 토스 블록 추가(플레이스홀더):
```
"_toss": "토스증권 Open API (OAuth2 Client Credentials) — 마스터만 입력",
"toss_client_id":      "",
"toss_client_secret":  "",
"toss_api_key":        "",   // TOSS-A 구현 키명(Hub toss.api_key)
"toss_secret_key":     "",   // TOSS-A 구현 키명(Hub toss.secret_key)
"toss_account_domestic": "",   // X-Tossinvest-Account (국내)
"toss_account_overseas": "",   // (해외)
"toss_live_trading":   false,  // 자동승급 전까지 false 고정
"toss_mode":           "shadow"  // shadow|live (C15 승격이 변경)
```
- **`secrets.ts` 확장**: `toss_*` 로드 + **검증 가드** — ①secret key가 비면 토스 어댑터 자동 비활성(읽기도 차단·경고) ②`toss_live_trading=true`인데 승급 미완료면 **기동 거부**(안전) ③secret 값은 로그·에러·텔레그램에 절대 미출력(마스킹 헬퍼).
- **마스터 입력 도구**: `bots/investment/scripts/toss-secret-doctor.ts`(edu-x `secrets-doctor.ts` 패턴) — 대화형으로 키 존재·형식·토큰 발급 1회 테스트(`/oauth2/token` 200 확인)만 수행, **값 표시 없이** "발급 성공/실패"만 출력. 마스터가 이 도구로 입력 검증.
- **코드가 키를 쓰는 방식**: 항상 공용 secret loader(`getTossCredentials()`/Hub config) 경유. 직접 하드코딩 금지. 정적 검사(스모크)에서 토스 키 문자열 하드코딩 0건 단언.

---

## 1. 기존 컴포넌트 보강 (토스 데이터 주입)

### C1 시장 배치 게이트 보강
- 게이트 입력에 토스 `/market/calendar`(휴장일 정확도)·`/market/price`(지수·대표종목) 추가. KIS와 **교차검증**(불일치 시 경고 로깅 — 데이터 품질 모니터). 결측 내성 유지.

### C3 전략군 / C7 백테스트 보강
- 캔들 소스를 토스 `/candles` 일원화 옵션(KIS 폴백). **비용 모델 보정**: 국내 수수료 무료 반영(현 백테스트 과대 비용 가정 수정 — next-bar 비교처럼 플래그 게이트로 OFF 기본·전후 비교).

### C4 사전 게이트 보강 [핵심 시너지]
- **외부 진실 교차검증 레이어**: G-rr·G-liquidity 판정 시 토스 `buying-power`·`sellable`·`commission` 호출해 우리 추정과 대조. 불일치=프리플라이트 신뢰도 하락 신호(shadow 로깅 → 정확도 개선 데이터). **승격 후 LIVE에선 토스 검증 통과를 진입 필수 조건으로** 강제.

### C14 데이터 소스 / 유니버스 보강
- **투자유의 종목 게이트 신설**: 토스 `securities-warning` → 유니버스에서 관리·환기·투자유의 종목 자동 배제(C4 또는 유니버스 빌더). KIS 대비 토스의 명확한 강점.
- 종목 마스터(`/stocks`) → 섹터·시장 메타 보강.

### C16 포지션 런타임 / C9 포지션·자본 보강
- 보유 재평가의 잔고 소스를 토스 `/accounts/holdings`로(실시간 평가금액·환율 반영). shadow: 조회·비교만. LIVE: 실잔고 기준 재평가.

---

## 2. LIVE 거래 — shadow → 자동승급 설계 [요구사항 3]

> 핵심: 토스는 sandbox가 없으므로 **shadow에서 충분히 검증 → C15 자동승급 → 소액 LIVE → 단계 확대**. 전 과정 C15(승격 제안 엔진) 표준 경로 재사용.

### 승급 단계 (Stage)
| Stage | 상태 | 행위 | 승급 기준(C15) |
|---|---|---|---|
| **S0 shadow** | 기본 | 토스 데이터로 신호·프리플라이트·서킷 전부 가상 — placeOrder 호출 0 | (시작점) |
| **S1 paper-mirror** | shadow+ | 실주문 직전까지 전 과정 수행 + 토스 사전검증 3종 실호출(읽기) — **주문만 미발행**, "발행했다면"을 토스 진실로 기록 | shadow 신호의 가상 성과 + 프리플라이트 외부검증 일치율 N% ↑·표본 ≥30 |
| **S2 micro-live** | LIVE 최소 | **1주/최소금액** 실발행 — capability ON, 일일 주문 수·금액 상한 극소 | S1 일치율·가상 성과 + 마스터 **명시 승인**(원클릭) + 무중단 체크 |
| **S3 scaled-live** | LIVE 확대 | 사이징 정상화(C9) | S2 실거래 N건 무사고·손익 추적·서킷 정상 작동 + 마스터 승인 |

- **각 단계 전환 = C15 승격 제안서**(근거·리스크·롤백=env 플래그). **S1→S2(첫 실발행)는 반드시 마스터 명시 승인**(자동 불가 — 안전). S2→S3는 기준 충족 시 제안.
- **롤백**: `toss_live_trading=false` 또는 `toss_mode=shadow` 한 줄로 즉시 전 단계 복귀. 서킷 발동 시 자동 shadow 강등.
- **C16 워치독 연동**: LIVE 단계에서 expected-fire 미발화·이상 손실 감지 시 자동 micro-live→shadow 강등 + 수시회의 트리거.

### 안전 불변식
- shadow/S0~S1에서 placeOrder 경로 **물리적 차단**(capability OFF·throw). S2 진입 전까지 실주문 0 보장(스모크 단언).
- LIVE 주문은 **반드시** 토스 사전검증 3종 통과 + C4 프리플라이트 통과 + 서킷 비잠금 — 3중 게이트.
- 일일 손실·주문 수·금액 상한(파라미터 스토어 tier=approve) — 초과 시 자동 정지.

---

## 3. 구현 분할 (CODEX 단위 — 검증 가능 최소 단위)

| 분할 | 범위 | 산출/검증 |
|---|---|---|
| **TOSS-A** | C18-4 시크릿(secret-store.md·secrets 확장·doctor) + C18-2 토스 클라이언트 읽기 전용(OAuth·시세·캘린더·환율) | 토큰 발급 1회·시세 1종 조회 성공(마스터 키 입력 후)·키 하드코딩 0 |
| **TOSS-B** | C18-1 BrokerAdapter + TossAdapter/KisAdapter 래핑 + MCP 토스 도구 4종 | 어댑터 인터페이스 일치·MCP 도구 응답·capability 게이팅(placeOrder 차단 확인) |
| **TOSS-C** | C14 투자유의 종목 게이트 + C1/C4 데이터 교차검증(shadow 로깅) + 백테스트 비용 보정(플래그 OFF) | 유의종목 배제 동작·교차검증 불일치 로깅·비용 OFF 회귀 diff 0 |
| **TOSS-D** | A2A 스킬 2종·훅·C16/C9 잔고 소스 + S0/S1 단계 머신(paper-mirror) + C15 토스 승급 기준 등록 | S1 사전검증 실호출+주문 미발행 단언·레지스트리 토스 컴포넌트 등록 |
| **TOSS-E**(보류) | S2 micro-live capability — **마스터 명시 승인 시에만 착수** | (실거래 — 별도 세션·극도 신중) |

- TOSS-A~D는 **전부 shadow/advisory**(실거래 0). TOSS-E는 마스터가 S1 검증 결과 보고 별도 결정.

---

## 4. 무중단·리스크 체크리스트
- [ ] PROTECTED 미중지 · crypto LIVE·스카 무중단 · 신규 plist 없음(기존 러너에 통합) · 토스 읽기 우선 · 키 노출 0
- [ ] shadow에서 placeOrder 물리 차단 검증 · S2 전 실주문 0 · LIVE 3중 게이트(토스 검증+C4+서킷)
- [ ] 토스 약관 준수(공식 Open API — 본인 계좌·정상 용도) · rate limit 백오프 · 토큰 캐싱
