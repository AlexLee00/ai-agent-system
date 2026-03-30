# Opus 세션 인수인계 — Chronos Phase A 전체 검증 완료 (2026-03-31)

> 작성일: 2026-03-31
> 모델: Claude Opus 4.6 (메티)
> 머신: 맥 스튜디오(OPS) — Desktop Commander 연결

---

## Chronos Phase A — 전체 검증 완료 (10/10)

### Layer 1~3 통합 검증

```
✅ Layer 1 (규칙 엔진): 121캔들→49신호→2거래, PnL -0.51%
✅ Layer 2 (qwen2.5-7b): 49신호 감성분석, 156초 (신호당 ~3.2초)
   JSON 응답: { sentiment: "BULLISH", confidence: 0.8, reasoning: "..." }
✅ Layer 3 (deepseek-r1-32b): 동작 확인
   첫 호출 75초 (on_demand 로드), 이후 ~2.2 tok/s
   200토큰 응답 90초, 체계적 사고 과정 포함

실측 속도:
  Layer 1: 수 초 (LLM 없음)
  Layer 2: ~3초/신호 (qwen 7b)
  Layer 3: ~90초/신호 (deepseek 32b)
  → 20신호 기준 Layer 3: ~30분 (설계 의도와 일치)
```

### 인프라 검증

```
✅ MLX v0.31.1 + mlx-openai-server v1.7.0
✅ 모델: qwen2.5-7b + deepseek-r1-32b
✅ launchd: ai.mlx.server (포트 11434)
✅ OpenAI /v1/chat/completions 호환 API
✅ on_demand deepseek (5분 미사용 시 자동 언로드)
```

### 코드 (커밋 79b0d73, 711줄/9파일)

```
✅ packages/core/lib/local-llm-client.js (116줄, 공용)
✅ bots/investment/shared/ohlcv-fetcher.js (175줄)
✅ bots/investment/shared/ta-indicators.js (61줄)
✅ bots/investment/team/chronos.js (346줄)
✅ packages/core/lib/env.js — LOCAL_LLM_BASE_URL 추가
```

---

## 발견 사항 + 개선 포인트

```
1. strategy 파라미터: '1'/'2'/'3'으로 Layer 지정 ('default'→NaN→Layer 1 폴백)
2. deepseek-r1-32b 응답이 thinking(사고과정) 포함 → JSON 파싱 실패 가능
   → callLocalLLMJSON에서 thinking 부분 제거 후 JSON 추출 필요
3. Layer 2 qwen 응답이 중국어 → 프롬프트에 "Answer in English" 추가 권장
4. Layer 3 속도 ~90초/신호 → Layer 2에서 상위 20개만 Layer 3으로 전달하는 필터 필요
5. technicalindicators 패키지가 OPS에만 설치됨 → package.json에는 포함 확인
```

---

## 다음 작업 순서

```
1순위: 블로팀 P1~P5 코덱스 프롬프트 작성
  → P1: 날씨 수치 제거 → 감성 표현
  → P2: 품질 검증 강화
  → P3: 프롬프트 최적화
  → P4: 도서리뷰 hallucination 방지
  → P5: 2026 SEO/AEO/GEO 적용

2순위: Chronos 개선 (Phase B)
  → Layer 3 JSON 추출 강화 (thinking 제거)
  → Layer 2 영어 응답 유도
  → Layer 2→3 필터 (상위 N개만)
  → 파라미터 최적화 루프

3순위: Shadow→Confirmation 전환 분석
4순위: DCA 전략
5순위: OpenClaw Phase 1
```

---

## 핵심 아키텍처 결정 (확정, 전체)

```
[DECISION] Ollama→MLX 전환 (20~50% 빠름, arXiv 2511.05502)
[DECISION] local-llm-client.js → packages/core/lib/ (공용)
[DECISION] MLX Tailscale 직접 (Hub 경유 안 함)
[DECISION] env.js LOCAL_LLM_BASE_URL: ops=localhost:11434, dev=REDACTED_TAILSCALE_IP:11434
[DECISION] deepseek on_demand: true (36GB 보호, 5분 언로드)
[DECISION] Kimi K2/K2.5: 128GB 필요 → 36GB 불가
[DECISION] 70B on 36GB: 실투자 안정성 위협 → 32B 유지
[DECISION] strategy='1'/'2'/'3' (Layer 지정)
[DECISION] Layer 3 속도: ~90초/신호 → 상위 20개만 전달
```
