# 팀 제이 — 시스템 전략 v4

> 작성일: 2026-03-31
> 비전: 완전자율 멀티에이전트 시스템
> 참조: team-jay-strategy.md (상세 원본)

---

## §1. 비전 — 완전자율 시스템 4계층

### Layer 1: Self-Healing (자가 복구)
```
현재: 닥터 scanAndRecover() — 에러 10건+ 서비스 자동 재시작
      덱스터 22개 체크 — 이상 감지 → 텔레그램 보고
목표: Elixir Supervision Tree → 밀리초 복구 + 프로세스 격리
패턴: Bounded Autonomy — 명확한 운영 한계 + 필수 에스컬레이션 + 감사 추적
```

### Layer 2: Self-Evolving (자가 진화)
```
현재: 블로팀 AI 피드백 루프 (제안→확인→학습)
      LLM 졸업 엔진 (반복 패턴 → 규칙 전환)
목표: 프롬프트 자동 최적화 (OpenAI Self-Evolving 패턴)
      전략 승격/강등 자동 루프 (Chronos strategy_registry)
패턴: 피드백 → 메타프롬프트 → 검증 → 프로덕션 반영
```

### Layer 3: Recursive Science (재귀적 과학)
```
현재: Chronos Layer 1 동작 (121캔들→49신호→2거래)
목표: Karpathy 패턴 — 전략 수정→5분 백테스트→개선→커밋 자동 루프
      strategy_registry 기반 전략 버전 관리 + 자동 승격/강등
패턴: 코드 수정 → 테스트 → 메트릭 개선 시 커밋 → 반복
```

### Layer 4: Bounded Autonomy (제한된 자율)
```
현재: 메티-코덱스-제이 3역할 (설계→구현→승인)
      OPS 직접 수정 금지 원칙 + 4중 안전장치
목표: Claude Code Skills/Hooks로 자동 가드레일
      MCP 표준화 → Hub를 MCP 서버로 노출
패턴: 자율 실행 + 명확한 경계 + 에스컬레이션 경로 + 감사 추적
```

---

## §2. 아키텍처 — 3계층 기술 스택

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

### Claude Code Skills/Subagents/Hooks (D 하위 C)
```
Phase 1 (즉시): 팀별 CLAUDE.md + 커스텀 Skills 5~10개
Phase 2 (Tier 2): Hooks (안전장치 자동화) + Subagents (메티 검증 자동화)
Phase 3 (Tier 3): Hub를 MCP 서버로 노출 + GitHub MCP 연결
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
[🔄] Chronos Phase A: Layer 2~3 LLM 호출 검증 (strategy='2'/'3')
[🔄] 문서 체계 v2: STRATEGY.md + CLAUDE.md 리팩터링 (이 작업)
```

### Tier 2 — 2~4주
```
[ ] 블로팀 P1~P5 구현 (날씨수치/품질검증/프롬프트/hallucination/SEO)
[ ] 옵션B (스카팀 reservation Phase E) 설계
[ ] OpenClaw Phase 1: mainbot.js 흡수
[ ] 루나팀: Shadow→Confirmation 전환 분석
[ ] 루나팀: DCA 전략
[ ] ComfyUI + 이미지 비용 $0 전환
```

### Tier 3 — 5~8주
```
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
| 2026-03-31 | v4 신설 — Self-Evolving/Self-Healing/Recursive Science/Bounded Autonomy |
