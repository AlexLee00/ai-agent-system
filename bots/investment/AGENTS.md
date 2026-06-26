# AGENTS.md — 루나팀 (투자/자동매매)

> 이 파일은 OpenAI Codex·Claude Code가 루나팀(bots/investment) 코드 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md(세션 규칙·역할 경계) + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 루나 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지. 산출물=명세(docs/codex/SPEC_*).
- **코덱스(OpenAI Codex)** = 명세 기반 구현. 모든 실제 파일 생성/수정.
- **마스터(제이)** = 승인·git commit·launchctl·DB write·실거래 토글. 이것들은 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증(문법/소프트/하드) → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
루나는 **실거래 운영 중**. 아래 직접 중지·변경 금지:
- launchd `ai.luna.*`·`ai.investment.*` (market-gate-30min·marketdata-mcp·crypto-holding-monitor-6h·fx-refresh·hybrid-promotion-gate-daily·disclosure-event-driven·expected-fire-watchdog 등)
- **Binance crypto = LIVE 실거래**. 청산/주문 로직 변경은 shadow(기본 OFF) 우선, 마스터 승인 후 enable.
- 국내(KIS)·해외(KIS overseas)도 실계좌 연결. 무중단.

## 팀 구조 (파이프라인)
```
[스크리닝] 아르고스(argos) → [분석] 아리아(aria,기술) + 소피아(sophia,감성) + 헤르메스(hermes,뉴스) + 오라클(oracle,온체인)
  → [종합판단] 루나(luna,팀장) → [리스크] 네메시스(nemesis)
  → [실행] 헤파이스토스(hephaestos,바이낸스) / 한울(hanul,국내외 KIS)
[백테스팅] 크로노스(chronos) · [조건부] 제우스(zeus)/아테나(athena)
[보조] 카이로스(kairos,타이밍)·센티넬(sentinel,감시)·adaptive-risk·hard-rule·scout(스크래핑)·sweeper(청산정리)·reporter·stock-flow·toss-market-intel·budget
```

## 핵심 파일 (전부 TypeScript — .js 아님)
- **team/**: luna.ts(팀장 오케스트레이션, getExitDecisions L548), nemesis.ts(리스크), hanul.ts(KIS 실행, listHanulExecutableSignals L1527), hephaestos.ts(바이낸스), chronos.ts(백테스팅)
- **shared/**: luna-market-deployment-gate.ts(시장게이트), luna-loss-circuit.ts(서킷), luna-exit-policy.ts(청산정책, KIS 지원), luna-regime-engine.ts(HMM 레짐), db.ts, capital-manager.ts
- **scripts/**: runtime-luna-market-gate.ts, crypto-holding-monitor.ts, domestic-holding-monitor.ts, kis-active-exit-monitor.ts, force-exit-runner.ts
- **packages/core/lib/**: 공용 (kst.js·pg-pool.js·hub-client.js·llm-fallback.js·local-llm-client.js·rag.js)

## 현재 상태 (2026-06)
- **거래 모드**: Binance crypto LIVE, 국내(KIS)·해외(KIS overseas) 실계좌 연결.
- **최근 실적(2개월)**: Binance +$3,191 + KIS -$469 + KIS OS -$68 = +$2,655 USD.
- **V2 전략**: 12주 Hybrid 8 Phase + USD 정규화 100%. Shadow Mode 7 Phase 가동.
- **최근 개선 (검증·커밋됨)**: 서킷 min_sample=3(노이즈 잠금 17→1, commit f5a8481d4), 시장게이트 regime_direction 결합(commit 1541bb2e1).
- **대기 중**: signal_reverse 능동청산 이식(kis-active-exit-monitor.ts 구현됨, 미커밋·검증 대기, LUNA_KIS_ACTIVE_EXIT_ENABLED=false shadow).
- **LLM**: 루나=groq_with_local(Groq Qwen3-32B → local deepseek-r1-32b 폴백). MLX qwen2.5-7b/deepseek-r1-32b.

## 루나 운영 주의 (실거래 — 필수 준수)
- **shadow 우선 원칙**: 모든 신규 기능은 shadow mode(기본 OFF)로 배포 → 로그 검증 → 마스터 승인 후 enable. kill-switch형(기본 OFF 안전) vs shadow-default형(기본 ON 누적) 구분.
- **손익 데이터 주의**: trade_journal 컬럼은 pnl_amount·pnl_net (realized_pnl_usdt 아님). exit_time은 bigint ms (to_timestamp(exit_time/1000)). Binance 부분체결 P&L 오기록 이력 있음(Layer1 보정 LUNA_JOURNAL_MICRO_ENTRY_MIN_USDT).
- **최소 샘플 게이팅**: 통계 기반 락(서킷 등)은 최소 샘플 조건 필수 (sample=1 과민반응 방지).
- **레짐 이중 엔진**: luna-regime-engine(HMM, 방향) + market-regime(변동성) 상호보완. HMM이 시장방향 1차.
- **TP/SL 필수**: 실투자 포지션은 거래소 TP/SL 설정 필수. tp_sl_set 확인 전 활성화 금지.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js (new Date() 직접 금지, kst.today())
- DB: packages/core/lib/pg-pool.js (또는 Hub 경유). PostgreSQL 단일(jay DB)+pgvector. 별도 DB 추가 금지.
- LLM: packages/core/lib/llm-fallback.js + llm-model-selector.js
- RAG: packages/core/lib/rag.js (Qwen3-Embedding-0.6B 1024차원)
- launchd: StartCalendarInterval은 KST 기준 (UTC 변환 금지)

## 구현 하네스 (코드 작업 시)
1. **Karpathy 4원칙** (~/.codex/AGENTS.md Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical, 검증 가능 성공기준.
2. **구현 후 검증 루프**: node --check [변경파일] → npx tsc --noEmit -p bots/investment/tsconfig.json → smoke 테스트(*-smoke.ts). 실패 시 최대 3회 자동수정, 3회 실패 시 마스터 보고.
3. **미검증 "완료" 보고 금지**. 검증 통과 후에만 완료.
4. **branch 전략**: main 직접 커밋(브랜치 미사용), 롤백은 git revert. 단 commit은 마스터.

## 참조 문서
- 전략: docs/strategy/luna.md | 개발: docs/dev/luna.md
- 설계: docs/design/LUNA_OPTIMAL_REDESIGN.md + 추적 LUNA_OPTIMAL_REDESIGN_TRACKER.md (C7-x)
- 명세: docs/codex/SPEC_*.md (메티 작성, 자동실행 금지)
- 세션 분석: docs/session/LUNA_*.md
