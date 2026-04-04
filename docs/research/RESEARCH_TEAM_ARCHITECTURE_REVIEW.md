# 전체 팀 아키텍처 비교 분석 계획 — 클로드 코드 패턴 기준

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-04
> 참조: docs/research/RESEARCH_CLAUDE_CODE_LEAK.md (391줄)
> 범위: 9팀 + 코어 모듈 + 오케스트레이터 전체

---

## 1. 전체 시스템 규모

```
팀별 코드 규모 (줄/파일):
  ska(스터디카페):  58,238줄 / 294파일  ★ 가장 큼
  worker(워커):     36,094줄 / 288파일
  investment(루나): 28,363줄 / 101파일
  reservation:      22,397줄 / 90파일
  claude(클로드):   12,345줄 / 58파일
  video(비디오):    11,652줄 / 48파일
  orchestrator:     10,146줄 / 48파일
  blog(블로):        8,950줄 / 31파일  ✅ 분석 완료
  hub:               1,409줄 / 11파일

코어 모듈:          13,973줄 / 63파일
스킬:               33파일
MCP:                4파일

전체: ~200,000줄+ / 1,781파일 / 90에이전트 / 9팀
```

---

## 2. 분석 프레임워크 — CC 패턴 7가지 기준

각 팀을 다음 7가지 기준으로 분석:

```
① 오케스트레이션 — 코드 기반 vs 프롬프트 기반
② 메모리/컨텍스트 — 장기 상태 관리, 컨텍스트 압축
③ 도구/스킬 — 권한 분리, 동적 선택
④ 실패 처리 — 연속 실패 제한, 폴백 체인
⑤ 보안 — 입력 검증, 권한 체크
⑥ 코드 품질 — 대규모 파일 안티패턴, 중복
⑦ 자율성 — 자기 학습, 피드백 루프
```

---

## 3. 분석 순서 + 일정

```
완료:
  ✅ 블로팀 (8,950줄/31파일) — 분석 완료 + 전략기획서 v2

순서 (규모+영향도 기준):
  ① 코어 모듈 (13,973줄/63파일) — 모든 팀의 기반!
  ② 오케스트레이터 (10,146줄/48파일) — 전체 조율 허브
  ③ 루나/투자 (28,363줄/101파일) — 실시간 트레이딩
  ④ 클로드팀 (12,345줄/58파일) — 시스템 모니터링
  ⑤ 워커 (36,094줄/288파일) — SaaS 포털
  ⑥ 스카 (58,238줄/294파일) — 스터디카페 관리
  ⑦ 비디오 (11,652줄/48파일) — 영상 편집
  ⑧ 연구/감정/데이터 (신규팀) — 코드 아직 적음
```

---

## 4. 팀별 분석 + CC 패턴 Gap

### 4-1. 코어 모듈 (13,973줄/63파일) — 모든 팀의 기반

```
현재 구조:
  LLM 계층 (3,571줄):
    llm-model-selector (702줄) — 모델 선택 로직
    llm-fallback (687줄) — 4단계 폴백 체인 ★ CC보다 우수!
    llm-logger (565줄) — 호출 로그
    llm-graduation (474줄) — 모델 승격/강등
    llm-cache (229줄) — 응답 캐시
    llm-router (137줄) — 라우팅
    local-llm-client (128줄) — 로컬 MLX 연결

  에이전트 계층 (1,163줄):
    hiring-contract (258줄) — 동적 고용 (ε-greedy!) ★ CC에 없음!
    agent-registry (245줄) — 에이전트 등록/조회
    competition-engine (162줄) — 경쟁 시스템 ★ CC에 없음!
    skill-selector (153줄) — 스킬 동적 선택
    tool-selector (155줄) — 도구 동적 선택

  인프라 (2,216줄):
    pg-pool (459줄) — PostgreSQL 연결
    telegram-sender (444줄) — 알림
    health-* (841줄) — 헬스 체크 5파일

CC 패턴 Gap:
  ❌ 컨텍스트 압축 시스템 없음 (CC: MicroCompact → AutoCompact → FullCompact)
  ❌ 연속 실패 제한 없음 (CC: MAX_CONSECUTIVE_FAILURES = 3)
  ❌ 프롬프트 캐시 최적화 없음 (CC: 14 캐시 파괴 벡터 추적)
  ✅ LLM 폴백 4단계 — CC보다 우수
  ✅ 에이전트 경쟁/고용 — CC에 없는 고유 강점
  ✅ 로컬 LLM 비용 $0 — CC 대비 최대 차별점

개선안:
  P0: llm-fallback.js에 MAX_CONSECUTIVE_FAILURES 추가
  P1: context-compactor.js 신규 생성 (MicroCompact + AutoCompact)
  P2: llm-cache.js에 프롬프트 캐시 불변/가변 분리
```

### 4-2. 오케스트레이터 (10,146줄/48파일) — 전체 조율

```
현재 구조:
  intent-parser (698줄) — 의도 파싱 (텔레그램 명령)
  night-handler (483줄) — 야간 자동 처리
  identity-checker (247줄) — 사용자 인증
  openclaw-config (182줄) — OpenClaw 설정
  router.js — 메시지 라우팅 (미분석)

CC 패턴 Gap:
  ❌ 프롬프트 기반 오케스트레이션 없음 (코드 if/else로 라우팅)
  ❌ AgentTool 패턴 없음 (에이전트가 다른 에이전트를 도구로 호출)
  ✅ night-handler — CC의 KAIROS와 유사한 야간 자율 모드!
  ✅ intent-parser — 자연어 의도 파싱

개선안:
  P1: intent-parser에 프롬프트 기반 의도 분류 추가 (현재 정규식)
  P2: 에이전트 간 위임 패턴 (AgentTool 유사)
  P3: night-handler → KAIROS 유사 자율 데몬으로 확장
```

### 4-3. 루나/투자팀 (28,363줄/101파일) — 실시간 트레이딩

```
현재 구조:
  DAG 파이프라인 (nodes/ 디렉토리):
    l01-pre-screen → l02-ta-analysis → l03-news/sentinel
    → l04-sentiment → l05-onchain → l06-portfolio-context
    → l10-signal-fusion → l11-bull-debate → l12-bear-debate
    → l13-final-decision → l14-portfolio-decision
    → l21-llm-risk → l30-signal-save → l31-order-execute
    → l32-notify → l33-rag-store → l34-journal

  ★ 이미 CC의 멀티에이전트 패턴과 매우 유사!
    Bull/Bear 토론 패턴 = CC의 Coordinator/Worker!
    l13-final-decision = CC의 Coordinator "약한 작업 승인하지마"!

CC 패턴 Gap:
  ❌ 컨텍스트 압축 없음 (장시간 모니터링 시 LLM 품질 저하)
  ❌ 실패 제한 없음 (API 장애 시 무한 재시도 가능)
  ❌ 야간 증류 없음 (매일 거래 패턴 학습 정리)
  ✅ DAG 파이프라인 — CC보다 체계적인 단계별 처리!
  ✅ Bull/Bear 토론 — CC에 없는 다자간 토론 패턴!
  ✅ Chronos 3단계 LLM 분석 — CC보다 깊은 분석!

개선안:
  P0: 연속 실패 제한 (API 장애 시 빠른 중단)
  P1: 야간 거래 복기 (nightly-trade-review.js) — CC autoDream 참조
  P2: 거래 결과 → RAG → 다음 판단 반영 (피드백 루프)
  P3: Strict Write Discipline — 성공 거래만 학습 메모리에 기록
```

### 4-4. 클로드팀 (12,345줄/58파일) — 시스템 모니터링

```
현재 구조:
  claude-lead-brain (486줄) — 팀 리더 두뇌
  doctor (458줄) — 자율 복구 ★ CC의 KAIROS와 유사!
  dexter-mode (398줄) — 모니터링 모드
  reporter (356줄) — 리포팅
  daily-report (328줄) — 일일 보고
  autofix (296줄) — 자동 수정
  team-bus (272줄) — 팀 간 통신
  ai-analyst (216줄) — AI 분석

  ★ Doctor + Autofix = CC의 KAIROS 자율 데몬과 매우 유사!
  ★ team-bus = CC의 AgentTool 통신 유사 (팀 간 메시지)

CC 패턴 Gap:
  ❌ 메모리 증류 없음 (매일 모니터링 패턴 정리)
  ❌ 프롬프트 기반 판단 없음 (autofix가 코드 기반)
  ✅ Doctor scanAndRecover — CC보다 자율적!
  ✅ team-bus — CC에 없는 팀 간 통신!
  ✅ autofix — CC에 없는 자동 수정!

개선안:
  P1: Doctor에 야간 시스템 건강 리포트 + 패턴 학습
  P2: autofix 판단을 프롬프트 기반으로 전환 (더 유연한 진단)
  P3: dexter-mode에 CC의 14 캐시 파괴 벡터 유사 모니터링 추가
```

### 4-5. 워커팀 (36,094줄/288파일) — SaaS 포털

```
현재 구조:
  Next.js 웹 애플리케이션 (가장 큰 UI 코드베이스)
  에이전트 오피스 대시보드
  포털 관리 시스템

CC 패턴 Gap:
  ❌ UI 상태 관리와 에이전트 상태의 연동이 약할 수 있음
  ✅ 에이전트 오피스 — CC에 없는 시각적 에이전트 관리!

개선안:
  P2: 에이전트 오피스에 CC 패턴 대시보드 추가
      (컨텍스트 사용량, 캐시 히트율, 실패율 시각화)
  P3: 워커 포털에서 Standing Orders 관리 UI
```

### 4-6. 스카팀 (58,238줄/294파일) — 스터디카페 관리

```
현재 구조:
  가장 큰 코드베이스! (58K줄)
  Python 기반 (src/) + Node.js (lib/)
  네이버 예약 모니터링 + 키오스크 관리

CC 패턴 Gap:
  ❌ Python/Node 혼합 → 통신 오버헤드 가능
  ❌ 코드 규모 대비 자동화 테스트 미확인

개선안:
  P2: Python→Node 통합 또는 명확한 인터페이스 정의
  P3: 58K줄 리팩토링 계획 (대규모 파일 안티패턴 점검)
```

### 4-7. 비디오팀 (11,652줄/48파일) — 영상 편집

```
현재 구조:
  Twick React SDK 타임라인 UI
  AI 스텝바이스텝 편집
  RED/BLUE 품질검증

CC 패턴 Gap:
  ❌ 영상 분석 → 판단 컨텍스트 관리 없음
  ✅ RED/BLUE 검증 — CC의 Coordinator 품질 게이트와 유사!

개선안:
  P2: 영상 메타데이터 → RAG 저장 (편집 패턴 학습)
  P3: Gemma 4 멀티모달로 영상 분석 보조
```

---

## 5. 전체 시스템 횡단 개선사항 (CC 패턴 기준)

### 5-1. 가장 큰 Gap 3개

```
Gap 1: 컨텍스트 압축 시스템 ★★★
  영향: 전 팀 (특히 루나 실시간, 블로 일일, 클로드 모니터링)
  현재: 없음
  CC: 4단계 압축 (MicroCompact → AutoCompact → FullCompact → Time-based)
  구현: packages/core/lib/context-compactor.js 신규
  효과: 장시간 에이전트 LLM 품질 유지

Gap 2: 연속 실패 제한 ★★★
  영향: 전 팀 (LLM 호출하는 모든 에이전트)
  현재: 없음 (llm-fallback.js 폴백은 있지만 세션 레벨 제한 없음)
  CC: MAX_CONSECUTIVE_FAILURES = 3 (25만 호출/일 절약)
  구현: llm-fallback.js에 3줄 추가
  효과: 불필요한 API/LLM 호출 방지, 비용 절약

Gap 3: 야간 메모리 증류 (autoDream) ★★☆
  영향: 전 팀 (학습하는 모든 에이전트)
  현재: ~/self-improving/ 수동 관리
  CC: autoDream — 유휴 시 메모리 정리, 모순 해결, 관찰→사실 전환
  구현: scripts/nightly-distill.js 신규
  효과: 매일 학습 품질 향상, 잘못된 메모리 정리
```

### 5-2. 이미 앞서가는 부분 (CC에 없음)

```
강점 1: 멀티팀 경쟁 시스템 (competition-engine.js)
  → 90에이전트 × 9팀 × ε-greedy 경쟁
  → CC는 단일 에이전트, 경쟁 패턴 없음
  → 이 패턴은 CC가 배워야 할 것!

강점 2: 도메인 특화 에이전트 생태계
  → 루나(투자) + 블로(블로그) + 스카(카페) + 에디(영상) 등
  → CC는 범용 코딩 에이전트 1개

강점 3: Doctor 자율 복구 (doctor.js + autofix.js)
  → scanAndRecover() 자율 루프
  → CC의 KAIROS는 아직 미출시. 우리는 이미 운영 중!

강점 4: 4단계 LLM 폴백 (llm-fallback.js)
  → 로컬 → Groq → OpenAI → Anthropic
  → CC는 Anthropic API 단일 의존

강점 5: Standing Orders 자동 규칙화 (openclaw)
  → 3회 반복 패턴 → 규칙 승격
  → CC는 프롬프트 수동 관리
```

### 5-3. 전체 개선 로드맵 (CC 패턴 적용)

```
즉시 (P0):
  □ llm-fallback.js 연속 실패 제한 (3줄 추가)
  □ self-improving Strict Write Discipline (성공 시에만 기록)

단기 1~2주 (P1):
  □ context-compactor.js 1단계 (MicroCompact — 로컬 트리밍)
  □ nightly-distill.js (야간 메모리 증류)
  □ intent-parser 프롬프트 기반 분류 추가
  □ commenter.js 감정 감지 정규식

중기 2~4주 (P2):
  □ context-compactor.js 2단계 (AutoCompact — 요약 생성)
  □ 에이전트 오피스에 CC 패턴 대시보드
  □ autofix 프롬프트 기반 진단 전환
  □ llm-cache 프롬프트 캐시 불변/가변 분리

장기 1~2개월 (P3):
  □ KAIROS 유사 자율 데몬 (deploy.sh 확장)
  □ AgentTool 패턴 (에이전트 간 위임)
  □ 피처 플래그 체계화
  □ 스카 58K줄 리팩토링 계획
```

---

## 6. 핵심 인사이트

```
"클로드 코드는 512K줄의 단일 에이전트 하네스.
 팀 제이는 200K줄의 멀티팀 에이전트 생태계.

 CC의 강점 (컨텍스트 압축, 메모리 증류, 실패 제한)을
 우리의 강점 (경쟁 시스템, 도메인 특화, 자율 복구) 위에
 레이어링하면, 어느 쪽도 단독으로 달성하지 못한
 '자율 진화하는 멀티도메인 에이전트 시스템'이 완성된다."
```

---

## 추가 연구 과제

```
□ 각 팀별 심층 코드 리뷰 (딥 분석 세션)
□ 코어 모듈 context-compactor 프로토타입
□ 루나팀 DAG vs CC coordinatorMode 상세 비교
□ 스카팀 58K줄 구조 분석 (Python/Node 혼합 이슈)
□ CC QueryEngine 46K줄 패턴 → 우리 llm-client 리팩토링 참조
□ CC bashSecurity 23항목 → Hub 보안 강화 적용
□ CC promptCacheBreakDetection → llm-cache 최적화
```
