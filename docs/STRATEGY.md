# 팀 제이 — 시스템 전략 v4

> 작성일: 2026-03-31
> 비전: 완전자율 멀티에이전트 시스템
> 참조: team-jay-strategy.md (상세 원본)

---

## §0. 핵심 원칙

### 일일 성장 원칙 (Daily Growth Principle)
```
모든 에이전트는 하루하루 지난 데이터를 바탕으로 성능이 향상되어야 한다.

메커니즘:
  1. 데이터 축적: 매일 운영 데이터 → DB + RAG 저장
  2. 패턴 학습: 축적된 데이터 → 성공/실패 패턴 추출
  3. 행동 개선: 학습된 패턴 → 프롬프트/규칙/전략 자동 조정
  4. 검증: 개선된 행동 → Shadow Mode 비교 → 승격/강등

기술 기반:
  - pgvector (RAG): 과거 사례 검색 + 유사 상황 참조
  - AI Feedback Loop: 제안→확인→학습→개선
  - strategy_registry: 전략 버전 관리 + 자동 승격/강등
  - runtime_config: 운영 파라미터 자동 튜닝
  - LLM 졸업 엔진: 반복 패턴 → 규칙 전환 (비용 절감 + 속도 향상)
```

### 체계화 우선 원칙
```
1. 이미 있는 것을 체계화하는 것이 최우선
2. 아직 없는 것은 팀 단위로 설계 → 구현
3. 프레임워크 도입과 패턴 참고 모두 적극 검토
4. Node.js 기반 유지 + Python 부분 도입 가능
```

### 팀 적용 순서 (확정)
```
제이(메인봇/OpenClaw) → 루나팀 → 스카팀 → 클로드팀 → 블로팀
→ 워커팀 → 에디팀(비디오팀) → 연구팀(예정) → 감정팀(예정)
```

---

## §1. 비전 — 완전자율 시스템 4계층

### Layer 1: Self-Healing (자가 복구)
```
원칙: 이상 감지 → 자동 복구 → 근본 원인 분석 → 예방

이미 있는 것 (체계화 대상):
  ✅ 닥터 scanAndRecover() — 에러 10건+ 자동 재시작
  ✅ 덱스터 22개 체크 — 이상 감지 → 텔레그램 보고
  ✅ launchd KeepAlive — 프로세스 크래시 시 자동 재시작
  ✅ Hub /hub/errors/recent — 에러 수집 + 분류
  ✅ health-provider.js — 팀별 헬스 체크 공용화

팀별 적용 계획:
  제이:   에러 패턴 DB 축적 → "이 에러는 재시작 vs 코드 수정" 자동 판단
  루나팀: 거래 실패 패턴 학습 → 자동 회복 (잔고 부족 → 포지션 조정)
  스카팀: 브라우저 크래시 패턴 → 자동 재시도 전략 최적화
  클로드팀: 닥터 scanAndRecover() 패턴 DB화 → 예방 조치 자동 제안

장기 목표: Elixir Supervision Tree → 밀리초 복구 + 프로세스 격리
```

### Layer 2: Self-Evolving (자가 진화)
```
원칙: 피드백 → 학습 → 프롬프트/규칙 개선 → 검증 → 프로덕션 반영

이미 있는 것 (체계화 대상):
  ✅ AI Feedback Layer (워커/블로/클로드) — 제안→확인→학습
  ✅ LLM 졸업 엔진 — 반복 패턴 → 규칙 전환
  ✅ Shadow Mode — 규칙 vs LLM 병렬 비교
  ✅ runtime_config 외부화 — 6팀 운영 파라미터

팀별 적용 계획:
  제이:   OpenClaw 라우팅 최적화 → 팀별 조율/컨트롤 향상, 시스템 안정화
  루나팀: Chronos 전략 → 백테스트 → 예측향상 + 수익률 향상
         RAG에 과거 매매 사례 축적 → 유사 상황 시 참조
  스카팀: 예외처리 로직 발견 + 실패 피드백 → 실패율 최소화
         forecast shadow → primary 자동 승격
  클로드팀: 코드 품질 향상 + 오류 사전 예방 (닥터 L1~L3)
  블로팀: 품질 향상, 주제 다양화, 클릭률 향상, SEO 최적화
         글 품질 피드백 → 프롬프트 자동 최적화 (OpenAI Self-Evolving)
  워커팀: 안정적인 웹환경 운영 + UX 개선 루프
  에디팀: 영상편집/생성 능력 향상
  연구팀: 최신기술 발굴능력 향상, 구현 및 적용 속도 향상
  감정팀: 다양한 케이스 학습 + 일반화, 예외 케이스 탐지

일일 성장 환류 사이클 (Daily Growth Cycle):
  ┌─────────────────────────────────────────────────┐
  │  1. 데이터 축적 (매일 자동)                       │
  │     운영 데이터 → DB + pgvector 임베딩 저장       │
  │     "왜 맞았는지/틀렸는지" 회고 데이터 포함        │
  │                                                   │
  │  2. 분석/리포트 (매일 아침)                       │
  │     전일 성과 분석 → 패턴 추출                    │
  │     성공/실패 원인 분류 → 개선 포인트 도출         │
  │                                                   │
  │  3. 피드백/대응 (자동 또는 마스터 승인)            │
  │     runtime_config 조정 제안                      │
  │     프롬프트 개선안 생성 → Shadow 비교             │
  │     규칙/임계값 자동 튜닝                          │
  │                                                   │
  │  → 다시 1로: 개선된 행동의 결과가 새 데이터로 축적 │
  └─────────────────────────────────────────────────┘
  주간: 누적 학습 → 전략/프롬프트 승격/강등 판단
```

### Layer 3: Recursive Science (재귀적 과학)
```
원칙: 전략 수정 → 테스트 → 메트릭 개선 시 커밋 → 반복 (Karpathy 패턴)

이미 있는 것 (체계화 대상):
  ✅ Chronos Layer 1~3 (MLX, 검증 완료)
  ✅ ohlcv_cache + ta-indicators
  ✅ local-llm-client.js (공용)

팀별 적용 계획:
  루나팀 (최우선):
    strategy_registry → 전략 버전 관리
    Chronos 루프: 전략 파라미터 변경 → 5분 백테스트 → 개선 시 저장
    walk-forward 검증 → Shadow → Confirmation → Live

  블로팀:
    글 템플릿 변형 → A/B 테스트 → 성과 측정 → 최적 템플릿 자동 선택

  스카팀:
    forecast 모델 파라미터 → shadow 비교 → 자동 튜닝
```

### Layer 4: Bounded Autonomy (제한된 자율)
```
원칙: 자율 실행 + 명확한 경계 + 에스컬레이션 + 감사 추적

이미 있는 것 (체계화 대상):
  ✅ 메티-코덱스-제이 3역할 (설계→구현→승인)
  ✅ 4중 안전장치 (DEV)
  ✅ OPS 직접 수정 금지 원칙
  ✅ 소스코드 수정 권한 제한

팀별 적용 계획:
  제이:   Claude Code Hooks → 자동 가드레일 (OPS 수정 차단)
  루나팀: 전략 승격 시 마스터 승인 필수 (Live 전환 게이트)
  전체:   Claude Code Skills → 팀별 컨텍스트 자동 로드
         Hub를 MCP 서버로 노출 → Claude Code에서 직접 제어
```

---

## §2. 아키텍처 — 3계층 기술 스택 + 9개 팀

### 팀 구조 (적용 순서)
```
운영 중:
  1. 제이 (메인봇/OpenClaw) — 총괄 허브, 오케스트레이션
     └─ 라이트(Write) — 문서 관리, 팀장회의록, 일일 리포트 (제이 직속)
  2. 루나팀 — 자동매매 (crypto live, 국내외 mock)
  3. 스카팀 — 스터디카페 예약/매출/예측
  4. 클로드팀 — 시스템 모니터링/복구/개발자동화 (덱스터/아처/닥터/리뷰어/가디언/빌더)
  5. 블로팀 — 네이버 블로그 자동화
  6. 워커팀 — 비즈니스 관리 SaaS
  7. 에디팀 (비디오팀) — 영상 자동편집/자동생성 시스템 (팀장: 에디)

예정:
  8. 연구팀 — 새로운 기술 연구+테스트, ai-agent-system 매시간 업그레이드를 위한 R&D
  9. 감정팀 — 법원 소프트웨어 감정 자동화/시스템화
```

```
┌───────────────────────────────────────────┐
│ Elixir/OTP 오케스트레이션 (두뇌) [Tier 3] │
│  → Supervision Tree = 자기복구            │
│  → GenServer = 팀장 상태 관리             │
│  → 핫코드 리로드 = 무중단 업데이트        │
├───────────────────────────────────────────┤
│ Node.js/TypeScript 에이전트 (근육) [현재]  │
│  → 30+ 봇 실행 로직                      │
│  → Playwright, WebSocket, API            │
│  → Hub(:7788) + OpenClaw(:18789)         │
├───────────────────────────────────────────┤
│ Python 마이크로서비스 (전문가) [Tier 2~3]  │
│  → MLX 로컬 LLM (:11434) ✅              │
│  → 백테스팅 (Chronos + VectorBT)         │
│  → 고급 RAG (LlamaIndex + pgvector)      │
└───────────────────────────────────────────┘
```

## §3. 기술 전략

### Claude Code Skills/Subagents/Hooks (D 하위 C, Claude Forge 패턴 참고)
```
참고: github.com/sangrokjung/claude-forge (분석 완료, 설치 아닌 패턴 참고)

Phase 1 (즉시): 팀별 CLAUDE.md ✅ + 커스텀 Skills 5개
  /plan      — 구현 계획 수립 + 위험 요소 파악
  /tdd       — RED→GREEN→REFACTOR 테스트 주도 개발
  /code-review — 코드 품질/보안/성능 자동 검토
  /verify-loop — 빌드/테스트 실패 → 자동 수정 → 재시도 반복
  /handoff-verify — 새 컨텍스트(fork)에서 독립 이중 검증

Phase 2 (Tier 2): Hooks 자동화 + MCP 추가
  PreToolUse: OPS 파일 수정 차단, secrets 접근 차단, 보안 검사
  PostToolUse: 자동 node --check, 영향 테스트 실행
  MCP 추가: context7 (최신 문서 조회), memory (세션 기억)

Phase 3 (Tier 3): Hub MCP + 보안 6계층
  Hub를 MCP 서버로 노출 → Claude Code에서 직접 제어
  6계층 보안: 시크릿필터+원격차단+SQL방지+코드변경+레이트리밋+커밋검사
```

### 클로드팀 보강 — 개발 자동화 (Claude Forge 패턴 적용)
```
현재 클로드팀:
  클로드(팀장) → 덱스터(22개 체크) + 아처(인텔리전스) + 닥터(복구)

보강 후 클로드팀:
  클로드(팀장)
    [유지] 덱스터 — 시스템 점검 (감지)
    [유지] 아처 — 기술 인텔리전스
    [강화] 닥터 — 복구 전문가 (인프라+코드 통합)
      Level 1: 서비스 재시작 (현재 scanAndRecover)
      Level 2: 설정 조정 (runtime_config 자동 튜닝)
      Level 3: 코드 패치 (/verify-loop, 자동 수정+테스트+재시도)
    [신설] 리뷰어 — 코드 리뷰 자동화 (/code-review)
    [신설] 가디언 — 보안 분석 (6계층 보안 훅)
    [신설] 빌더 — 빌드/배포 자동화 (워커 Next.js + TS 컴파일 + npm)

코드 구현 후 자동화 워크플로:
  코덱스 구현 완료
  → 리뷰어: 자동 코드 리뷰 (품질/보안/성능)
  → 닥터 Level 3: 테스트 실행 → 실패 시 자동 수정 → verify-loop
  → 가디언: 보안 검사
  → 빌더: 빌드 검증 (Next.js, npm)
  → 메티: 전략적 최종 확인만
  → 마스터: 승인

유지보수/패치 자동화:
  덱스터 에러 감지
  → 닥터 Level 1~3: 재시작 → 설정 조정 → 코드 패치 (단계적 에스컬레이션)
  → 코드 변경 시: 리뷰어 + 가디언 + 빌더 검증
  → 마스터 승인 (코드 변경 시만)
```

### 멀티에이전트 패턴 참고
```
TradingAgents: 멀티에이전트 토론 → 루나팀 재설계 참고 (⭐⭐⭐)
LangGraph:     상태 그래프 → 투자 파이프라인 상태 머신 (⭐⭐)
CrewAI:        선언적 정의 → 봇 config 체계화 (⭐⭐)
MCP/A2A:       에이전트 통신 표준화 → 장기 (⭐)
```

### 로컬 LLM (MLX, 확정)
```
✅ MLX v0.31.1 + mlx-openai-server v1.7.0 (OPS :11434)
✅ qwen2.5-7b (Layer 2 감성, ~80 tok/s)
✅ deepseek-r1-32b on_demand (Layer 3 판단, ~22 tok/s)
   Kimi K2/K2.5: 128GB 필요 → 불가
   70B: 36GB 스왑 → 실투자 위협 → 불가
```

---

## §4. Tier 로드맵

### 즉시 진행 중
```
[✅] Chronos Phase A: Layer 1~3 검증 완료
[✅] 문서 체계 v2 + CLAUDE.md 리팩터링 + STRATEGY.md v4
[🔄] Claude Forge 패턴 분석 → 클로드팀 보강 설계 완료, 구현 대기
```

### Tier 2 — 2~4주
```
[ ] Claude Code Skills Phase 1: /plan /tdd /code-review /verify-loop /handoff-verify
[ ] 클로드팀 보강: 리뷰어 + 가디언 + 빌더 신설, 닥터 Level 1~3 강화
[ ] 블로팀 P1~P5 구현 (날씨수치/품질검증/프롬프트/hallucination/SEO)
[ ] 옵션B (스카팀 reservation Phase E) 설계
[ ] OpenClaw Phase 1: mainbot.js 흡수
[ ] 루나팀: Shadow→Confirmation 전환 분석
[ ] 루나팀: DCA 전략
[ ] ComfyUI + 이미지 비용 $0 전환
```

### Tier 3 — 5~8주
```
[ ] Claude Code Hooks Phase 2: 보안 자동화 + MCP (context7, memory)
[ ] Claude Code 보안 6계층 구현
[ ] 루나팀 Phase 4: 펀딩레이트 + 그리드
[ ] 블로팀 본격 개발 (24노드 n8n)
[ ] 비디오팀 Phase 3 (Twick + ComfyUI + Whisper)
[ ] 워커팀 SaaS 재개
[ ] TS Phase 1: TypeScript 강화
[ ] TS Phase 2: Elixir 오케스트레이션
[ ] Cloudflare Tunnel + 도메인
```

---

## §5. 인프라

```
OPS: Mac Studio M4 Max 36GB — 24/7 운영
  PostgreSQL 17 + pgvector (:5432)
  Hub (:7788) — secrets/errors/pg-query
  MLX (:11434) — qwen2.5-7b + deepseek-r1-32b
  n8n (:5678), OpenClaw (:18789)
  launchd 자동 실행 + deploy.sh cron 5분

DEV: MacBook Air M3 24GB — Tailscale 연결
  SSH 터널 (포트 15432→OPS PG)
  Hub/MLX Tailscale 직접 접근 (REDACTED_TAILSCALE_IP)

네트워크: Tailscale VPN (DEV↔OPS)
```

## §6. 비용 전략

```
텍스트 LLM: $0/월 (gpt-4o 25만 무료 + Groq 무료 + MLX 로컬)
이미지:     ~$8/월 → $0 전환 예정 (ComfyUI FLUX)
로컬 LLM:  $0 (MLX qwen+deepseek)
총 비용:   ~$8/월 → $0 목표
```

---

## 변경 이력

| 날짜 | 변경 |
|------|------|
| 2026-03-31 | v4 §0 일일성장원칙+체계화우선+팀적용순서(9팀), §1 4계층 팀별 적용 계획 |
| 2026-03-31 | v4 §3 Claude Forge 패턴 분석→Skills/Hooks/보안 설계, 클로드팀 보강(닥터강화+리뷰어+가디언+빌더) |
