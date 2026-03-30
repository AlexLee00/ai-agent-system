# Opus 세션 인수인계 — Chronos Phase A 완료 (2026-03-31)

> 작성일: 2026-03-31
> 모델: Claude Opus 4.6 (메티)
> 머신: 맥 스튜디오(OPS) — Desktop Commander 연결

---

## 1. 이번 세션 성과

### OPS Phase A 검증 통과 (10/10)

```
✅ Ollama 제거 (바이너리 + 데이터)
✅ MLX v0.31.1 + mlx-lm + mlx-openai-server v1.7.0
✅ 모델: qwen2.5-7b + deepseek-r1-32b (다운로드 완료)
✅ MLX 서버 동작 (포트 11434, OpenAI 호환 API)
✅ launchd 등록 (ai.mlx.server, PID 28836)
✅ config.yaml (host 0.0.0.0, on_demand deepseek)
✅ qwen2.5-7b 추론: "2" (1+1 정답)
✅ deepseek-r1-32b 추론: 22.8초 응답 (on_demand 로드 포함)
```

### DEV Phase A 코드 도착 + 검증 (부분)

커밋: 79b0d73 — 711줄 추가, 9파일

```
✅ 문법 검사 4파일 통과
✅ local-llm-client.js: 6개 함수 export, MLX 서버 연결 성공
✅ env.js: LOCAL_LLM_BASE_URL DEV/OPS 분기
✅ OHLCV 수집: ccxt → 697개 캔들 PostgreSQL 저장
✅ technicalindicators: OPS npm install 완료
✅ Chronos Layer 1: 121캔들→49신호→2거래, PnL -0.51%, 샤프 -2.22
🔄 Chronos Layer 2 (qwen): 테스트 중 (LLM 호출 소요)
⏳ Chronos Layer 3 (deepseek): Layer 2 확인 후

발견: strategy 파라미터에 '3' 넘겨야 Layer 3 동작
     ('default' → NaN → Layer 1 폴백)
```

### 리서치 완료

```
Kimi K2/K2.5: 성능 최상급(HLE 50.2%)이나 최소 128GB 필요 → 36GB 불가
70B on 36GB: 기술적으로 가능하나 스왑 발생, ~3 tok/s, 실투자 안정성 위협
결론: 32B deepseek-r1-distill이 36GB 최적 (메모리 내 안정, ~22 tok/s)
```

### 전략 문서 업데이트 완료

- STRATEGY_SESSION_PROMPT.md (227줄): Tier 2 MLX 반영 + 블로팀 딥분석 + 에러해소
- OPUS_FINAL_HANDOFF.md: 이 파일

---

## 2. 다음 세션 작업

```
1. Chronos Layer 2~3 검증 완료
   → Layer 2: runBacktest('BTC/USDT', '2026-03-25', '2026-03-30', '2', {maxLayer2Signals:3})
   → Layer 3: runBacktest('BTC/USDT', '2026-03-20', '2026-03-30', '3', {maxLayer2Signals:5, maxLayer3Signals:3})
   → deepseek on_demand 첫 로드 시간 고려 (타임아웃 길게)

2. 블로팀 P1~P5 코덱스 프롬프트 작성

3. 이후: Shadow→Confirmation, DCA, OpenClaw
```

---

## 3. 핵심 아키텍처 결정 (확정)

```
[DECISION] Ollama→MLX 전환 (20~50% 빠름, arXiv 2511.05502)
[DECISION] local-llm-client.js → packages/core/lib/ (공용)
[DECISION] MLX Tailscale 직접 (Hub 경유 안 함)
[DECISION] env.js LOCAL_LLM_BASE_URL: ops=localhost:11434, dev=REDACTED_TAILSCALE_IP:11434
[DECISION] deepseek on_demand: true (36GB 보호)
[DECISION] Kimi K2/K2.5: 128GB 필요 → 36GB 불가
[DECISION] 70B on 36GB: 실투자 안정성 위협 → 32B 유지
[DECISION] strategy 파라미터: '1'/'2'/'3'으로 Layer 지정 ('default'는 Layer 1)
```

---

## 4. 파일 참조

```
Chronos:
  docs/CODEX_CHRONOS_PHASE_A_OPS.md (270줄) — ✅ OPS 완료
  docs/CODEX_CHRONOS_PHASE_A_DEV.md (194줄) — ✅ DEV 커밋 완료
  packages/core/lib/local-llm-client.js (116줄)
  bots/investment/shared/ohlcv-fetcher.js (175줄)
  bots/investment/shared/ta-indicators.js (61줄)
  bots/investment/team/chronos.js (346줄)

전략: docs/STRATEGY_SESSION_PROMPT.md (227줄)
블로팀: docs/BLOG_DEEP_ANALYSIS_2026-03-30.md (245줄)
```
