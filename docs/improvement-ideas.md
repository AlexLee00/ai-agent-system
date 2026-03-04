# 시스템 개선 아이디어 & 개발 백로그

> 최종 업데이트: 2026-03-04
> 맥미니 M4 Pro 64GB 주문 완료 (2026-03-03) — 약 6주 후 도착 예정 (4월 중순)

---

## 🔴 지금 당장 할 수 있는 것

| # | 항목 | 내용 | 비고 |
|---|------|------|------|
| LU-KIS | KIS 모의투자 장 시간 체결 확인 | kis-client.js 구현 완료, API 연결 검증 완료 (2026-03-03). 내일 09:00~15:30 KST에 실행 필요 | 매수: `PAPER_MODE=false node team/hanul.js --symbol=005930 --action=BUY --amount=200000` |
| CL-008 | 아처 루나 성과 통합 | fetchLunaPerformance() 구현됨, 승률 데이터 30일 누적 대기 중 | 90% 완료 |

---

## 🟠 중기 개선 (언제든 진행 가능)

### RAG 통합 로드맵 (우선순위: 스카 → 제이 → 루나)

> RAG 서버: `localhost:8100` (FastAPI 래퍼, ChromaDB PersistentClient)
> OpenClaw 통합 방법: ①SKILL.md (즉시) ②TypeScript Plugin tool (고도화)
> 연구 완료: 2026-03-05

#### 스카팀 RAG (ROI 최고 — 레베카·이브 데이터 직접 활용)

| # | 항목 | 내용 | 구현 단계 | 예상 효과 |
|---|------|------|-----------|-----------|
| SKA-RAG-01 | **레베카 예측 정확도 개선** | 과거 예약 패턴을 ChromaDB `ska_reservations` 컬렉션에 벡터 저장. Prophet 예측 시 유사 날짜 패턴(공휴일 전날, 시험기간 등) 참조 → MAPE 15%→8% 목표. `bots/ska/src/rebecca.py`에 `POST /search` 호출 추가 | 1단계: ChromaDB 컬렉션 생성 + 예약 데이터 임베딩 / 2단계: 레베카 예측 루프에 RAG 컨텍스트 주입 | 예측 정확도 ↑, 덱스터 MAPE 경보 감소 |
| SKA-RAG-02 | **이브 환경 데이터 장기 벡터화** | 이브가 수집하는 날씨·공휴일·학사일정·축제를 ChromaDB `ska_environment` 컬렉션에 누적. 레베카가 예측 시 "작년 같은 날씨·이벤트 조합" 검색 → 계절성 패턴 자동 반영. `bots/ska/src/eve.py` 수집 루프에 `POST /ingest` 추가 | 1단계: 이브 수집 루프에 벡터 저장 / 2단계: 레베카 RAG 쿼리에 환경 컬렉션 포함 | 계절·이벤트 예측 정확도 ↑ |

#### 제이팀 RAG (즉시 적용 가능)

| # | 항목 | 내용 | 구현 단계 | 예상 효과 |
|---|------|------|-----------|-----------|
| JY-RAG-01 | **SKILL.md RAG 연동** | 제이의 OpenClaw SKILL.md에 `search_rag` 스킬 등록. 예약규정 질문·과거이슈·시스템 설명 요청 시 `GET localhost:8100/search?q=...` 호출 후 컨텍스트 주입. **코드 수정 없음, SKILL.md만 편집**. 컬렉션: `orchestrator_knowledge` | 1단계: SKILL.md 편집 + 지식 문서 임베딩 (MAINBOT.md, 운영가이드 등) | 운영 질문 응답 품질 ↑, 할루시네이션 ↓ |
| JY-RAG-02 | **OpenClaw Plugin RAG tool** | TypeScript로 RAG Plugin 등록 (`~/.openclaw/plugins/rag-search/`). SKILL.md보다 정밀한 컨텍스트 윈도우 제어 가능. `tool_call` 형태로 호출 → 응답 스트리밍 지원 | 1단계: JY-RAG-01 완료 후 / 2단계: Plugin 등록 + 컬렉션 멀티 쿼리 | 다중 컬렉션 동시 검색, 팀별 답변 통합 |

#### 루나팀 RAG (중장기 — 30일 데이터 누적 후)

| # | 항목 | 내용 | 구현 단계 | 예상 효과 |
|---|------|------|-----------|-----------|
| LU-RAG-01 | **매매 이력 → 아리아 신호 보조** | 바이낸스 실거래 결과(진입가·청산가·수익률·시장상황)를 ChromaDB `luna_trades` 컬렉션에 저장. 아리아 신호 생성 시 "이 조합에서 과거 승률" 검색 → LLM 프롬프트 컨텍스트 추가. `bots/investment/src/analysts/signal-aggregator.js`에 RAG 쿼리 추가 | 1단계: 사이클 완료 시 trade record 벡터화 / 2단계: 아리아 LLM 호출 전 RAG 컨텍스트 주입 | 과거 실패 패턴 재방지, 신호 정확도 ↑ |
| LU-RAG-02 | **뉴스·공시 벡터화 → 오라클 강화** | 오라클이 수집하는 뉴스/공시를 ChromaDB `luna_news` 컬렉션에 임베딩. 동일 이슈 반복 감지 (중복 알람 제거) + 과거 유사 뉴스 시장반응 참조. `team/oracle.js` Groq 분석 전 RAG 검색 추가 | 1단계: 뉴스 수집 시 벡터 저장 / 2단계: 오라클 분석 프롬프트에 유사 뉴스 이력 포함 | 뉴스 분석 정확도 ↑, 중복 알람 ↓ |

| # | 항목 | 내용 |
|---|------|------|

---

## 🟠 맥미니 도착 전 (맥북에서 준비)

| # | 항목 | 내용 |
|---|------|------|
| Phase 2 준비 | 맥미니 이전 체크리스트 | state.db / secrets.json / config.yaml / launchd plist 이전 절차 문서화 |
| LU-039 | ChromaDB 학습 루프 | 30일 드라이런 데이터 누적 후 진행 — 매매 신호 패턴 벡터 저장 |
| CL-006 | 전체 코드 리팩토링 | coding-guide.md 기준 소급 적용 — 기능 변경 없이 구조 개선 |
| ska-002 | 스카 ETL 추가 검증 | SQLite→DuckDB 파이프라인 실데이터 검증 |

---

## 🟢 맥미니 도착 후 (Phase 2~4)

| # | 항목 | 내용 |
|---|------|------|
| Phase 2 | 전체 시스템 맥미니 이전 | 봇 전부 맥미니로 이전 + Tailscale 재설정 + 맥북은 개발 전용 |
| LT-003 | 신규 팀 구축 | main창: 메인봇/비서봇/업무봇 / research창: 학술봇/판례봇 |
| CL-005 | GUI 대시보드 | Grafana+Loki or 커스텀 Express+SSE — 봇 활동 시각화 |
| LU-025 | 루나 OPS 전환 | 바이낸스 실거래 전환 (맥미니 안정화 후) |
| LU-039 | ChromaDB 학습 루프 | 맥미니 로컬 LLM(ollama) 연동 가능해지면 고도화 |
| DX-001 | 덱스터 패턴 벡터화 | dexter_error_log → ChromaDB 벡터 저장 → 유사 오류 사전 감지 (단기 SQL 패턴 이후) |
| LT-002 | Playwright → 네이버 API | UI 변경 취약점 근본 해결 — 장기 검토 |
| LT-004 | RAG 도입 | ChromaDB 봇별 컬렉션 분리 — 예약 패턴 벡터 저장 |

---

## ✅ 완료 이력 (2026-03-04 기준)

### 스카팀

| 항목 | 완료일 | 내용 |
|------|--------|------|
| 기본 OPS 구축 | 2026-02-24 | naver-monitor + pickko 자동화 전체 |
| 픽코 자동화 전체 | 2026-02-24~27 | 등록/취소/조회/티켓/멤버/이름수정 CLI 9종 |
| 텔레그램 자연어 27케이스 | 2026-02-26 | E2E 100% 통과 |
| pickko↔네이버 이름 동기화 | 2026-02-26 | syncMemberNameIfNeeded() |
| 텔레그램 pending-queue | 2026-02-26 | 3회 재시도 + jsonl 대기큐 |
| 키오스크→네이버 자동 해제 | 2026-02-26 | pickko-kiosk-monitor Phase 2B+3B |
| 공유 인프라 | 2026-02-27 | packages/core + playwright-utils + _template |
| lib/ 공용 라이브러리 | 2026-02-27 | cli/args/utils/secrets/telegram/browser/pickko |
| pre-commit hook | 2026-02-27 | 보안 파일 커밋 차단 |
| 헬스체크 / 로그rotation | 2026-02-27 | health-check.js + log-rotate.sh |
| ska-001~008 매출예측 | 2026-02-27 | DuckDB + 이브 공공API + 레베카 + Prophet |
| SKA-P01~P08 루나 패턴 이식 | 2026-03-02 | DB마이그레이션/Secrets폴백/Preflight/에러트래커/E2E/모드분리/상태파일 |
| SKA-N01 결제대기 자동화 | 2026-03-02 | pickko-pay-scan 09:30 launchd |
| SKA-N02 VIP 고객 인식 | 2026-03-02 | lib/vip.js 3등급 + 텔레그램 배지 |
| SKA-N03 주간 KPI 리포트 | 2026-03-02 | rebecca.py weekly_report() 월요일 09:00 |
| 취소 감지 교차검증 | 2026-03-02 | currentCancelledList 비교 + 이용완료 추정 스킵 |
| 앤디 에러 캡처 | 2026-03-02 | outputBuf → error_reason DB 저장 |
| 스카팀 고도화 v3.0 | 2026-03-03 | 폴더 재편(auto/manual) + state-bus + 덱스터 연동 |
| OBSERVE_ONLY 수정 | 2026-03-03 | 하드코딩 → `${OBSERVE_ONLY:-0}` 환경변수 우선 |
| reload-monitor.sh | 2026-03-03 | 빠른 재시작 (문법체크→정지→시작→확인, E2E 없음) |
| pickko-verify 경로 수정 | 2026-03-03 | v3.0 폴더 재편 후 경로 불일치 수정 |
| 스카팀 완전 OPS 전환 | 2026-03-03 | OBSERVE_ONLY 제거, 전체 OPS |

### 루나팀

| 항목 | 완료일 | 내용 |
|------|--------|------|
| Phase 0 드라이런 | 2026-03-01 | LU-001~015 BTC/ETH/SOL/BNB DRY_RUN |
| 제이슨 v2 TA 고도화 | 2026-03-02 | 6지표 + 다중 심볼 |
| 감성/온체인/뉴스 분석가 | 2026-03-02 | LU-032~034 Groq 기반 |
| 강세/약세 리서처 | 2026-03-02 | LU-035 debate 엔진 |
| 리스크 매니저 v2 | 2026-03-02 | LU-036 ATR+상관관계+시간대+LLM 4단계 |
| 백테스팅 엔진 | 2026-03-02 | LU-037 4심볼 1d/4h 텔레그램 리포트 |
| 몰리 v2 TP/SL | 2026-03-02 | LU-038 ±3% 자동 청산 |
| 루나 펀드매니저 | 2026-03-02 | LU-030 claude-haiku-4-5 |
| reporter.js 성과 리포트 | 2026-03-02 | 일/주/월 매매 성과 텔레그램 |
| Phase 3-A 크립토 사이클 | 2026-03-02 | bots/investment/ ESM + PAPER_MODE |
| Phase 3-B 국내외주식 | 2026-03-02 | aria KIS Yahoo OHLCV + domestic/overseas |
| Phase 3 E2E 전체 통과 | 2026-03-02 | 3사이클 8.4s/4.3s/5.9s |
| 크립토 OPS 전환 | 2026-03-03 | PAPER_MODE=false, $138 USDT 실거래 자금 |
| Groq 9키 라운드로빈 | 2026-03-03 | 4→9키 확장, 429 분산 |

### 공통 인프라 / LLM 키 통합

| 항목 | 완료일 | 내용 |
|------|--------|------|
| LLM API 키 통합 | 2026-03-04 | packages/core/lib/llm-keys.js 공용 로더 — config.yaml 단일 소스 |
| secrets.json LLM 키 제거 | 2026-03-04 | investment/secrets.json 중복 키 삭제 (anthropic/groq/cerebras/sambanova/xai) |
| launchd 하드코딩 제거 | 2026-03-04 | ai.investment.crypto.plist ANTHROPIC_API_KEY 삭제 |
| openai/gemini config 추가 | 2026-03-04 | config.yaml에 openai/gemini 섹션 추가 (사용자 키 입력 대기) |

### 클로드팀

| 항목 | 완료일 | 내용 |
|------|--------|------|
| 코딩가이드 초판 | 2026-02-27 | 기술스택/모델/OpenClaw/보안 패턴 |
| 덱스터 구축 | 2026-03-01 | 8체크 + 자동수정 + 버그레포트 + 일일보고 |
| 아처 v1 구축 | 2026-03-01 | 주간 기술동향 리포트 |
| 클로드팀 고도화 v2.0 | 2026-03-03 | team-bus + 아처 v2 재정의 + PATCH_REQUEST.md |
| 덱스터 메모리 오탐 수정 | 2026-03-03 | os.freemem() → vm_stat (macOS Inactive 고려) |
| team-features.md | 2026-03-03 | 팀별 기능 목록 문서 |
| team-profiles.md | 2026-03-03 | 팀별 프로필 문서 |
| pre-commit yaml 검사 | 2026-03-03 | .yaml/.yml/.sh/.env 파일까지 시크릿 검사 확장 |
| config.yaml git 정리 | 2026-03-03 | filter-repo로 전체 이력 제거 + .gitignore 등록 |
| 코딩가이드 v3 | 2026-03-03 | §0보안/§11재시작/§14OBSERVE_ONLY/§17클로드팀/보안사고 반영 |

### 메인봇 (오케스트레이터 / 제이)

| 항목 | 완료일 | 내용 |
|------|--------|------|
| 메인봇 구현 | 2026-03-04 | mainbot.js/router/filter/dashboard + launchd ai.orchestrator |
| 팀별 publishToMainBot | 2026-03-04 | 스카(CJS) + 루나(ESM) + 클로드(CJS) 클라이언트 |
| sendTelegram 전면 교체 | 2026-03-04 | 전체 봇 → publishToMainBot (mainbot_queue 경유) |
| time-mode.js 연동 | 2026-03-04 | 루나팀 사이클/minScore 시간대별 자동 조정 |
| parse_mode HTML | 2026-03-04 | telegram.js + mainbot.js 포매팅 버그 수정 |
| 4096자 분할 전송 | 2026-03-04 | mainbot.js splitMessage() |
| docs/MAINBOT.md | 2026-03-04 | 설계/아키텍처/명령체계/6주 안정화 계획 |
| LLM_DOCS.md §8·§9 신규 | 2026-03-04 | Telegram Bot API 9.5 + OpenClaw 섹션 추가 |

### OpenClaw / 인프라

| 항목 | 완료일 | 내용 |
|------|--------|------|
| OC-001~009 전체 | 2026-03-02 | 보안/denyCommands/SecretRef/세션초기화/dmScope 등 |
| BOOT 속도 최적화 | 2026-02-27 | 7분→54초 (8.4× 개선) |
| CL-004 Dev/OPS 분리 | 2026-03-02 | mode.js + switch-to-ops.sh |

---

## 🗂️ 아키텍처 개선 아이디어 (미결)

### 맥미니 이전 후 검토

| # | 아이디어 | 내용 | 우선순위 |
|---|---------|------|---------|
| A1 | 로컬 LLM 전략 | 맥미니 M4 Pro 64GB → ollama/qwen2.5:32b, deepseek-r1:32b 운용 가능 | 맥미니 도착 후 |
| A2 | Grafana + Loki | 봇별 메트릭 시각화 — 지금은 텔레그램+로그로 충분 | Phase 2 이후 |
| A3 | KIS 웹소켓 실시간 | 현재 polling → 웹소켓 전환 시 지연 개선 | LU-KIS 이후 |
| A4 | Playwright → API | 네이버 UI 변경 취약점 근본 해결 — 공식 API 가능 여부 확인 필요 | 장기 |
| A5 | n8n 트리거 활용 | DART 공시 polling → n8n 스케줄 트리거로 구현 | Phase 2 이후 |

### 스카팀 장기 기능

| # | 아이디어 | 우선순위 |
|---|---------|---------|
| IS-001 | 네이버 세션/쿠키 만료 자동 재개 | 낮음 (현재 자동 재시작 루프로 커버) |
| LT-002 | Playwright → 네이버 API 직접 호출 | 낮음 (장기 검토) |

---

## 📌 다음 세션 추천 작업 (2026-03-05 기준)

**루나팀 OPS 운영 중** — 맥미니 도착(4월 중순)까지:

1. **바이낸스 USDT 입금** → 실주문 활성화 ($100 이상 권장)
2. **수익률 데이터 누적** — 30일 후 `npm run report`로 신호 정확도 평가
3. **KIS 실계좌 전환 시점 판단** — 암호화폐 성과 검토 후 결정
4. **맥미니 이전 체크리스트 문서화** (이전 당일 빠르게 진행하기 위해)

### 루나팀 차기 개선 아이디어 (Phase 3-C 이후)

| # | 아이디어 | 우선순위 |
|---|---------|---------|
| ~~LU-001~~ | ~~reporter.js launchd 일일 자동 발송~~ | ✅ 완료 (2026-03-05) |
| ~~LU-002~~ | ~~asset_snapshot 주기적 기록 → 자산 곡선 추이~~ | ✅ 완료 (2026-03-05) |
| LU-003 | 신호 정확도 백테스트 (chronos.js Phase 3-D) | 중간 |
| ~~LU-004~~ | ~~USDT 잔고 부족 시 자동 텔레그램 알림~~ | ✅ 완료 (2026-03-05) |
| LU-005 | KIS 실계좌 전환 (kis_paper_trading=false) | 낮음 (성과 검증 후) |
