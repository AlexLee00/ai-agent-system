# 피드백 루프 + 이벤트 레이크 통합 구현 계획!

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-07
> 참조: AGENT_EVENT_LAKE_STRATEGY.md, 기존 피드백 코드 전수 분석
> 전제: 이벤트 레이크 Phase 1 코덱스 구현+테스트 완료!

---

## 1. 현재 피드백 루프 정밀 분석

### 피드백 루프 7단계별 현황

```
① 각 팀 독립 작업
   ✅ 다윈: 06:00 scanner, 07:00 task-runner
   ✅ 블로그: 06:00 daily (lecture+general)
   ✅ 루나: 매매 모니터링
   ✅ 스카: 예약 관리
   ✅ 클로드: 덱스터 모니터링
   = 전 팀 정상 작동!

② 1차 원천 데이터 생산/저장
   ✅ console.log/warn/error: 183개 호출 → /tmp/*.log
   ✅ rag_operations: 1,403건 (독터 복구!)
   ✅ rag_trades: 935건 (매매!)
   ✅ rag_research: 470건 (논문!)
   ✅ rag_experience: 381건 (에이전트 경험 + why!)
   ✅ rag_market_data: 12,416건 (시장!)
   ✅ rag_blog: 75건 (블로그!)
   = 대도서관 16,935건 축적 중! 원천 데이터 풍부!

③ 2차 분석/가공 데이터
   ✅ 블로그: analyze-blog-performance → gems/pos 점수!
   ✅ 독터: getPastSuccessfulFix → 유사 복구법!
   ⚠️ 시그마: sigma-daily.js 2건만! (launchd 미등록!)
   ❌ 다윈: 연구 성과 분석 리포트 없음!
   ❌ 루나: 매매 성과 분석 자동화 없음!
   = 블로그/독터만 분석 가동! 나머지 미가동!

④ 대도서관 저장 (시계열/분류/라벨링)
   ✅ RAG 12컬렉션: 벡터 검색 가능!
   ✅ event_lake 테이블: 존재! 인덱스 5개!
   ❌ event_lake 데이터: 0건! (연동만 되면 쌓임!)
   = 그릇은 준비됐지만 아직 비어 있음!

⑤ 각 팀 자체 피드백 (L1)
   ✅ 블로그: 성과 피드백 → gems/pos score 조정 → 고용 조합!
   ✅ 독터: RAG 검색 → 유사 복구법 자동 적용!
   ❌ 다윈: 연구 성과 자체 피드백 없음!
   ❌ 루나: 매매 성과 자체 피드백 없음!
   ❌ 스카: 예약 성과 자체 피드백 없음!
   = 블로그/독터만 L1 작동! 나머지 미가동!

⑥ 시그마팀 피드백 (L2 크로스/L3 메타)
   ❌ sigma-daily.js: launchd 미등록!
   ❌ L2 크로스팀: 사실상 미가동!
   ❌ L3 메타분석: 사실상 미가동!
   = 시그마팀 출근 안 하는 상태!

⑦ 시스템 진화
   ✅ experience why 1단계 구현!
   ❌ Instinct 진화: 2단계 대기 (4/21!)
   ❌ MAPE Plan+Execute: 없음!
   ❌ 누락 지식 감지: 없음!
   = 진화 기반은 준비, 실행은 미가동!
```

### 이벤트 레이크 Phase 1 구현 현황

```
✅ 구현 완료:
  event-lake.js (231줄) — record/search/stats/addFeedback/initSchema!
  Hub /hub/events/ — search/stats/feedback 라우트!
  central-logger.js (64줄) — error/warn → event_lake 자동!
  rag.js → event_lake 동시 저장! (storeExperience!)
  research-scanner → event_lake (research_scan!)
  applicator → event_lake (research_propose!)

❌ 미연동:
  implementor → event_lake ✗
  verifier → event_lake ✗
  collect-competition → event_lake ✗
  sigma-feedback → event_lake ✗
  analyze-blog-performance → event_lake ✗
  collect-performance → event_lake ✗
  독터 doctor.js → event_lake ✗
```

---

## 2. 통합 구현 계획 (4단계!)

### Phase A (즉시!): 시그마 활성화 + 이벤트 레이크 연동 완성!

```
목표: 피드백 루프의 ⑤⑥ 단계 가동!
시간: 3~4시간!

Task A-1: 시그마 launchd 등록!
  → ai.sigma.daily.plist 생성 + 매일 21:30!
  → sigma-daily.js 자동 실행 시작!
  → L1/L2/L3 피드백 가동!
  → CODEX_SIGMA_ACTIVATION.md 참조!

Task A-2: 이벤트 레이크 나머지 5곳 연동!
  → implementor.js + event_lake.record (research_implement!)
  → verifier.js + event_lake.record (research_verify!)
  → collect-competition-results.js + event_lake.record (blog_competition!)
  → doctor.js + event_lake.record (system_recover!)
  → analyze-blog-performance.js + event_lake.record (blog_feedback!)

Task A-3: central-logger 핵심 3곳 전환!
  → research-scanner → createLogger (이미 연동됨, 포맷만!)
  → implementor → createLogger
  → verifier → createLogger

결과:
  event_lake에 데이터 쌓이기 시작!
  시그마팀 L1/L2/L3 매일 가동!
  = 피드백 루프 ④⑤⑥ 가동!
```

### Phase B (1주 후!): 라벨링 + 자동 점수 + 팀별 L1 확장!

```
목표: 피드백 품질 향상! 분류/라벨링 표준화!
시간: 4~5시간!

Task B-1: 표준 이벤트 타입 전 팀 적용!
  → 다윈: research_scan/evaluate/propose/implement/verify/merge/task
  → 블로그: blog_generate/publish/performance/competition/feedback
  → 루나: trade_signal/execute/exit/pnl
  → 시스템: system_error/recover/deploy/health

Task B-2: 표준 태그 규칙 적용!
  → team:/agent:/domain:/trigger:/status: 접두사!
  → 모든 event_lake.record 호출에 tags 추가!

Task B-3: 자동 점수 계산!
  → research: relevance_score → event score!
  → blog: views/comments → event score!
  → trade: PnL → event score!
  → system: 복구 성공 = 8, 실패 = 2!

Task B-4: 다윈/루나 L1 자체 피드백 추가!
  → 다윈: 주간 연구 성과 자체 분석!
  → 루나: 주간 매매 성과 자체 분석!

결과:
  event_lake에 표준 라벨 + 점수!
  시계열 트렌드 분석 가능!
  전 팀 L1 자체 피드백!
```

### Phase C (2주 후!): 시그마 event_lake 연동 + 데이터 큐레이션!

```
목표: 시그마가 event_lake 기반으로 분석!
시간: 1주!

Task C-1: 시그마 L1~L3에서 event_lake 조회!
  → sigma-analyzer.js: event_lake.search() 사용!
  → 기존 pgPool 직접 쿼리 → event_lake 표준 API!
  → 시계열 트렌드 (이번 주 vs 지난 주!)

Task C-2: 데이터 큐레이션 (Data Flywheel 보완 1!)
  → 성공 패턴 vs 실패 패턴 자동 선별!
  → score 기반 상위 10% = "best practice"!
  → score 기반 하위 10% = "anti-pattern"!
  → 선별 결과 → rag_experience에 라벨링!

Task C-3: RAG 검색 품질 평가 (AITL 보완 3!)
  → searchExperience 결과 사용 후 피드백!
  → "실제로 도움이 됐는지" event_lake 기록!
  → 시그마가 RAG 검색 품질 트렌드 분석!

Task C-4: 시그마 리포트 → 텔레그램 자동 발송!
  → 일일: 팀별 이벤트 현황 + 에러 트렌드!
  → 주간: 성과 비교 + drift 감지 + 개선 제안!

결과:
  시그마가 event_lake 데이터 기반 분석!
  데이터 큐레이션 → 학습 품질 향상!
  RAG 검색 품질 추적!
```

### Phase D (1개월 후!): MAPE + 누락 지식 + Instinct!

```
목표: 피드백이 자동 개선 행동으로 연결!
시간: 2주!

Task D-1: MAPE Plan+Execute (보완 2!)
  → 시그마 L3 → improvement_proposals 자동 생성!
  → 텔레그램 [✅승인] [❌거절] 버튼!
  → 승인 시 코덱스가 자동 구현 (Sprint 4 연동!)
  → = 분석 → 계획 → 실행 자동화!

Task D-2: 누락 지식 감지 (보완 3!)
  → 에이전트 실패 시 "어떤 지식 부족?" 기록!
  → event_lake: event_type = 'knowledge_gap'!
  → 다윈팀이 해당 주제 자동 연구 과제 생성!
  → = 피드백 루프 → 연구 과제 자동 생성!

Task D-3: Drift Detection!
  → 팀별 주간 성과 시계열 비교!
  → 성과 하락 감지 → 자동 알림!
  → Arize AI 패턴 참조!

Task D-4: experience why 2~3단계!
  → Evidence + Confidence 구조화! (4/21!)
  → Instinct → 규칙 졸업! (5/7!)
  → ECC Instinct 패턴 참조!

결과:
  피드백 → 개선 계획 → 자동 실행!
  지식 갭 → 자동 연구!
  성능 변화 자동 감지!
  = 완전 자율 진화 시스템!
```

---

## 3. 전체 타임라인

```
4/7 (오늘!)
  ✅ event_lake Phase 1 구현 완료!
  ✅ 전략 문서 + 피드백 루프 보완 3가지!
  📋 Phase A 코덱스 전달!

4/8~10 (이번 주!)
  → Phase A: 시그마 활성화 + 이벤트 레이크 연동!
  → Sprint 4 풀런 관찰!
  → event_lake 데이터 축적 시작!

4/14~18 (다음 주!)
  → Phase B: 라벨링 + 자동 점수 + L1 확장!
  → 1주차 event_lake 데이터 분석!

4/21~25 (3주차!)
  → Phase C: 시그마 event_lake 연동!
  → experience why 2단계 시작!
  → 데이터 큐레이션!

5/5~ (5주차!)
  → Phase D: MAPE + 누락 지식 + Instinct!
  → 완전 자율 진화 시스템!
```

---

## 4. 피드백 루프 완성 체크리스트

```
① 각 팀 독립 작업
  [✅] 전 팀 정상 작동!

② 1차 원천 데이터 생산/저장
  [✅] RAG 16,935건!
  [Phase A] event_lake 연동 5곳 추가!

③ 2차 분석/가공 데이터
  [✅] 블로그 성과 + 독터 복구!
  [Phase B] 다윈/루나 L1 추가!

④ 대도서관 저장 (시계열/분류/라벨링)
  [✅] RAG 12컬렉션!
  [✅] event_lake 테이블!
  [Phase A] 데이터 쌓이기 시작!
  [Phase B] 라벨링 표준화!

⑤ 각 팀 자체 피드백
  [✅] 블로그/독터!
  [Phase B] 다윈/루나 추가!

⑥ 시그마팀 피드백
  [Phase A] sigma launchd 등록!
  [Phase C] event_lake 연동!

⑦ 시스템 진화
  [✅] experience why 1단계!
  [Phase C] 데이터 큐레이션!
  [Phase D] MAPE + Instinct!
```
