# 루나 백테스트 게이트 정밀 분석 — 핸드오프

- 분석일: 2026-06-24
- 분석: 메티
- 상태: **분석 완료, 완화 방향 마스터 선택 대기**
- 후속: 마스터가 방향 선택 → 코덱스 명세 → 구현 → 메티 검증

## 1. 게이트 구조 (핵심)

- `investment.candidate_backtest_status.would_block` 이 **실제 차단 신호**.
- `enforced` 컬럼은 **죽은 컬럼** — 코드 어디서도 읽지 않음(grep 0건), refresh에서 저장만 됨. `enforced=0` 이어도 `would_block=true` 면 실제 차단됨.
- `would_block` 소비 경로 3개:
  - `bots/investment/shared/predictive-validation.ts` — **메인 strategy/L13 경로** → `block_backtest_gate` (line 241-243, 315)
  - `bots/investment/shared/entry-trigger-engine.ts` — 보조 entry_trigger 경로 + DSR 하드블록 (line 153, 161, 192-197)
  - `bots/investment/team/hephaestos/execution-guards.ts` — 실행 직전 가드

## 2. 차단 현황 (crypto 157/157 = 100%, healthy=0)

market별: domestic 607/606, overseas 372/367, crypto 157/157 차단. 전 market enforced=0.

차단 사유 분포 (crypto, 중첩 허용):
| 사유 | 건수 | 비율 |
|---|---|---|
| outside_binance_top30_volume_universe | 82 | 52% |
| candidate_backtest_dsr_low | 67 | 43% |
| walk_forward_period_failed | 63 | 40% |
| sharpe_negative | 60 | 38% |
| drawdown_high | 46 | 29% |
| win_rate_low | 35 | 22% |

oos_status 분포: null 84, unstable 39, **ok 30**, insufficient_data 4. oos=ok 30건은 전부 `would_block_unhealthy`.

## 3. 완화 레버 ROI (crypto 157 기준, 순수 단일 차단)

"순수 단일 차단" = 그 게이트만 풀면 다른 차단 사유 없이 즉시 진입 가능한 종목 수.

| 레버 | 순수 구제 | 표면 사유 | 성격·트레이드오프 |
|---|---|---|---|
| **top30 유니버스 확대** | **82** | 82 | 백테스트 품질 무관. 유동성↓ → 슬리피지/체결 리스크 |
| DSR 게이트 OFF | **4** | 67 | 표면 67건이나 63건은 진짜 품질 문제 동반. 순수 4건뿐 |
| 순수 품질 미달(neither) | 8 | 8 | top30 안 + DSR 아님. 실제 5분봉 sharpe<0/win<30 |

**핵심 반전**: 진입 가뭄의 최대 백테스트 병목은 **DSR이 아니라 top30 유니버스 필터(82건)**. 이전 DSR=0 집중 가설은 정정됨. DSR 게이트를 꺼도 순수 구제는 4건뿐(나머지는 walk_forward/sharpe 품질 문제 동반).

oos=ok 30건(백테스트 통과 우량후보)은 전부 top30 안(universe 차단 0), 전부 DSR로 차단(30/30), 그 중 26건은 sharpe_negative·walk_forward도 동시.

## 4. 근본 원인 (왜 100% 차단)

- `healthy = !effectiveWouldBlock` (refresh.ts line 839), `effectiveWouldBlock = wouldBlock || dsrWouldBlock` (line 783).
- `wouldBlock` = reasons에 sharpe_/unrealistic_/overfit_/insufficient_oos/backtest_unstable/low_trade/**walk_forward_period_failed**/win_rate_/drawdown_ 중 하나라도 있으면 true (line 681-690). 다수 OR → 한 종목이 모든 조건 동시 통과 어려움.
- **walk_forward_period_failed** (line 655-658): 다기간(30/90/180일) 중 **하나라도** win<30% 또는 sharpe<0 이면 차단. 5분봉 크립토에서 전 기간 win≥30 AND sharpe≥0 동시 만족 = 구조적으로 거의 불가.
- GATE 상수 (refresh.ts line 33-43): MIN_SHARPE 0, MAX_DRAWDOWN 30, MIN_WIN_RATE 30, MAX_ABS_SHARPE 8, MIN_PERIOD_TRADES 5, MIN_TOTAL_TRADES 12. 백테스트 기간 default '30,90,180'.
- DSR 게이트 (line 770-783): `LUNA_DSR_GATE_ENABLED=true`(refresh plist 확인), `LUNA_DSR_MIN` 기본 0.90, `LUNA_DSR_MIN_TRADES` 기본 30. 5분봉 per-period sharpe 작아 DSR 구조적 미달.

## 5. 다음 세션 진입점 — 완화 방향 3택 (마스터 선택 대기)

1. **top30 → top50 확대** (`bots/investment/shared/binance-top-volume-universe.ts`): 최대 효과(82건)지만 유동성 기준 신중 설계 필요. 슬리피지/체결 리스크 평가 동반.
2. **walk_forward 완화** (refresh.ts line 655-658): 전 기간 필수 → 다수결(2/3 기간 통과). 8건 품질 종목 일부 구제 + 5분봉 현실 반영. 코드 수정.
3. **현상 유지**: 게이트는 정상 작동, 진짜 병목은 루나 L13 에이전트(별도 결론)이므로 게이트 미변경.

선택 후 절차: 마스터 방향 확정 → 메티가 코덱스 명세(docs/codex/) 작성 → 코덱스 구현 → 메티 검증(문법/소프트/하드) → 마스터 적용. crypto LIVE PROTECTED 원칙상 어떤 변경이든 shadow/dry-run 검증 후 적용.

## 6. 핵심 파일·라인 레퍼런스

- `bots/investment/scripts/runtime-luna-candidate-backtest-refresh.ts` — healthy/gate_status/would_block 계산·저장. GATE 상수 L33, walk_forward L655-658, wouldBlock L681-690, dsrWouldBlock L770-783, effectiveWouldBlock L783, healthy L839, gateStatus L840.
- `bots/investment/shared/candidate-backtest-gate.ts` — evaluateCandidateBacktestStatus. wouldBlock 재계산 L272 (would_block||!fresh||!healthy||drawdown||sharpe||dsr), enforced 미참조.
- `bots/investment/shared/predictive-validation.ts` — 메인 경로 소비. L120, L241-243, L315, L321, L340, L344.
- `bots/investment/shared/entry-trigger-engine.ts` — 보조 경로 소비. L22, L144, L153, L161, L192-197.
- `bots/investment/shared/binance-top-volume-universe.ts` — top30 유니버스 필터.
- DSR 게이트 env: `~/Library/LaunchAgents/ai.luna.candidate-backtest-refresh.plist`, `ai.luna.ops-scheduler.plist` (LUNA_DSR_GATE_ENABLED=true).
- 조회: `psql -d jay` → `investment.candidate_backtest_status` (market='crypto', block_reasons jsonb).


---

# [업데이트 2026-06-24 오후] 완화 방향 1번(유니버스 확대) 진행 — 코드 완료, env+refresh 대기

## 결정 및 완료 현황

완화 방향 **1번(top30→50 유니버스 확대)** 선택 후 진행. 추가 분석으로 국내/국외는 이미 top50(`kis-top-volume-universe.ts` `DEFAULT_KIS_UNIVERSE_LIMIT=50`)임이 확인되어, 유니버스 확대는 **암호화폐 전용**으로 확정. (국내/국외 병목은 별개 — domestic: backtest_low_trade_sample 404·insufficient_oos 331 / overseas: overfit_gap_high 165·walk_forward 155.)

| 작업 | 커밋 | 상태 |
|---|---|---|
| 접근 A (핵심 7곳 'top30'→'top' 일반화 + LIMIT env화) | `c9b25e41e` | ✅ 커밋 (메티 검증 통과) |
| 접근 A-2 (hardcoded limit:30 전수 제거 → env 통일 + 문자열) | `2245ce959` | ✅ 커밋+푸시 (메티 검증 통과) |

명세 문서: `docs/codex/CODEX_LUNA_BINANCE_UNIVERSE_EXPANSION_2026-06-24.md` (A), `docs/codex/CODEX_LUNA_BINANCE_UNIVERSE_LIMIT_UNIFY_2026-06-24.md` (A-2).

## 핵심 설계 (구현 완료)

- `DEFAULT_BINANCE_TOP_VOLUME_LIMIT = Math.max(1, Number(process.env.LUNA_BINANCE_TOP_VOLUME_LIMIT) || 30)` — env 가변 (기본 30, 운영 50).
- `fixedLimit()` 입력값 존중하도록 수정 (과거 30 하드고정 제거).
- `runtime-luna-binance-top-volume-universe.ts`, `runtime-luna-promotion-entry-trigger-materialize.ts`의 hardcoded `limit:30` → `DEFAULT_BINANCE_TOP_VOLUME_LIMIT` (import 추가).
- 'top30' 차단 신호 문자열 → 'top' 일반화. 매칭 목록(candidate-backtest-gate `UNIVERSE_BLOCK_PREFIXES`, watchdog `NORMAL_ENTRY_TRIGGER_BLOCK_REASONS`)은 **신규+레거시 병기**(하위호환, DB 마이그레이션 불필요). gate_status `would_block_top30_universe`→`would_block_universe`. 모든 변경 지점에 의도 주석.
- `off_universe_top30_liquidation_candidate`→`off_universe_top_liquidation_candidate` (3곳, 매칭 의존 없음).

## env 반영 실증 (메티 검증)

env=30 → fixture top=30 / env=50 → top=35(fixture 풀 최대) / env=200 → top=35. **env가 유니버스 크기를 정확히 제어 확인** (live 환경은 50개). smoke `runtimeExpandedLimit:50` 확인.

## ★ 다음 세션 진입점 — env=50 적용 + 분포 검증 (통합 순서 2~4)

코드는 A+A-2 모두 커밋·검증 완료. 남은 것은 **실제 50 적용**뿐:

1. **env 설정 (마스터)**: 유니버스 사용 plist에 `LUNA_BINANCE_TOP_VOLUME_LIMIT=50` 추가. 대상: `ai.luna.candidate-backtest-refresh.plist`, `ai.luna.ops-scheduler.plist`, entry-trigger/discovery 계열. **일부만 넣으면 프로세스마다 30/50 불일치** — import 그래프로 유니버스 사용 프로세스 전수 확인 필요.
2. **DB refresh 재실행 (마스터)**: `candidate_backtest_status` 갱신 → 31~50위 백테스트 평가 + `would_block_universe` 생성.
3. **메티 분포 검증**: before(universe 차단 **82건**, gate_status `would_block_top30_universe`) → after (① universe 차단 감소 ② 31~50위 신규 종목이 oos_status 채워지며 평가됨 ③ `would_block_universe` 신규 생성 ④ 레거시 `top30` 행도 `evaluateCandidateBacktestStatus`에서 여전히 universe 차단 분류되는지 = 병기 효과).

## 주의 (PROTECTED)

- env=50은 crypto LIVE 진입 후보를 늘리는 운영 변경. **평가 → 관찰 → 판단** 점진 적용. 한 번에 50 LIVE 강제 금지.
- 유니버스 확대 ≠ 즉시 82건 진입. 31~50위가 백테스트 평가 대상이 되는 것이고, healthy/walk_forward 게이트는 그대로 작동 → 백테스트 통과분만 진입 후보.
- 유동성 관찰: 신규 편입 종목의 실제 거래대금 확인. 슬리피지 우려 시 limit 40 하향 가능.

## 미진행 후속 (선택)

- 변수명 리네이밍(`inBinanceTop30Universe`/`binanceTop30Rank`/`top30Blocker` ~11곳): 기능 무관·가독성 목적. 별도 작업으로 분리 권장.
- 커밋 `c9b25e41e`에 claude refactor-cycle 작업 혼입됨(autofix budget 0.25→1.0) — branch-guard/worktree 격리 점검 권장 (기능 무해).
- 국내/국외 백테스트 완화(거래부족/과적합/walk_forward) — 유니버스와 별개 레버, 별도 과제.


---

# [세션 2 마감 — 2026-06-24 저녁] env=50 적용 완료 + 검증 통과 + 신규 병목 발견

## ✅ 이번 세션 완료

**env=50 적용 + 분포 검증 성공.** 통합 순서 ①~④ 모두 실행:
1. plist 3개 env=50 적용 (repo+설치본): `ai.luna.candidate-backtest-refresh`, `ai.luna.ops-scheduler`, `ai.luna.universe-refresh-daily-0830`. launchctl reload 완료.
2. `run-universe-refresh.ts` env=50 수동 1회 → top volume 후보 50 정상 확장.
3. `runtime-luna-candidate-backtest-refresh.ts --periods=180 --json` env=50 수동 1회 → DB 갱신(17:00).
4. 메티 분포 검증 완료.

## 검증 결과 (candidate_backtest_status, crypto)

| gate_status | 건수 | 해석 |
|---|---|---|
| would_block_universe | 79 | **실제 거래대금 top50 밖** (정당한 차단, 라이브 대조 완료) |
| would_block_unhealthy | 69 | ← 31~50위 신규 편입분이 여기로 (백테스트 품질 게이트) |
| would_block_unstable_backtest | 7 | |
| would_block_no_oos | 3 | |

- 레거시 `would_block_top30_universe` = **0건** (신규 문자열 완전 전환 확인).
- **31~50위 신규 편입 종목이 universe 게이트 통과 확인**: BICO/ALLO/LAYER/ONDO/HBAR/FET/DYDX/JTO 모두 `would_block_universe` 아님 → `unhealthy`/`no_oos`로 이동 = 백테스트 평가 단계 진입.
- **ONDO/USDT는 `oos_status='ok'` 도달** (안정성 게이트 통과) — 유니버스 확대의 실질 효과 첫 사례.
- 79건 universe 차단(ATOM/ALGO/CHZ/FIL/TIA/SEI/SHIB/RENDER 등)은 라이브 바이낸스 USDT 현물 거래대금 50위 밖 확인 → 오차단 아님.

## 핵심 교훈 (메티 진단)

- candidate-backtest-refresh는 `getCachedBinanceTopVolumeUniverse()`를 **`refresh:true` 없이** 호출(L1433). 캐시는 모듈 메모리 변수(in-process, TTL 24h). 프로세스가 매번 새로 시작되므로 **그 프로세스의 env로 유니버스를 빌드** → env=50 직접 실행이 정답이었음.
- 16:06 1차 refresh가 79건이었던 건 08:30 universe-refresh가 채운 **30 기준 캐시**를 읽었기 때문(마스터 env=50은 오후 추가). = **순서 문제**였고, env=50 재실행으로 해소.
- ATOM 같은 전통 메이저도 바이낸스 USDT 현물 거래대금 50위 밖일 수 있음(밈코인/신규상장 쏠림). "메이저=top50" 가정은 틀림 — 반드시 라이브 rank 확인.

## 미커밋 (마스터 커밋 대기)

```
M bots/investment/launchd/ai.luna.candidate-backtest-refresh.plist
M bots/investment/launchd/ai.luna.ops-scheduler.plist
M bots/investment/launchd/ai.luna.universe-refresh-daily-0830.plist
M docs/session/LUNA_BACKTEST_GATE_ANALYSIS_2026-06-24.md
```
(docs/codex 아님 → 정상 커밋 가능. 코덱스 프롬프트 3개는 docs/codex/archive/로 물리 이동 완료, git 미추적 작업파일이라 커밋 불필요.)


## ★★ 다음 세션 진입점 — 안건 2개

### 안건 ① dynamic-universe-selector crypto=30 하드코딩 (이번 세션 신규 발견)

**증상**: universe-refresh 로그 `[DynamicUniverse] binance/TRENDING_BEAR — 후보 50개 → 선택 30개`. top volume 후보는 env=50으로 50개 정상인데, **dynamic universe 최종 선택에서 다시 30으로 잘림**.

**원인 위치**: `bots/investment/shared/dynamic-universe-selector.ts`
- L27 `DEFAULT_UNIVERSE_SIZE = { crypto: 30, domestic: 50, overseas: 50 }` — **크립토만 30 하드코딩, env 게이트 없음**. (국내/해외는 이미 50이라 이 경로에선 무영향 → 크립토만 문제.)
- L187 `const maxSize = options.universeSize ?? (exchange==='binance' ? DEFAULT_UNIVERSE_SIZE.crypto : ...)` — **`options.universeSize`로 override 가능**.
- L233 `const selected = scored.slice(0, maxSize)` — 여기서 30개로 절단.

**`LUNA_BINANCE_TOP_VOLUME_LIMIT`(후보군 크기)와 별개의 2단 게이트**임에 주의. 2단 구조:
- 1단 top volume 후보군 = `LUNA_BINANCE_TOP_VOLUME_LIMIT` → ✅ 50 적용됨(세션 1~2)
- 2단 dynamic universe 최종 선택 = `DEFAULT_UNIVERSE_SIZE.crypto=30` → ❌ 아직 하드코딩

**선결 과제 (구현 전 메티 분석 필요)**:
1. **소비처 매핑**: dynamic-universe-selector의 `selectedSymbols`가 어디서 소비되는가? candidate_backtest_status의 universe 차단은 `evaluateBinanceTopVolumeUniverseGate`(top volume 50 기준)를 쓰므로 **백테스트 게이트는 이미 50으로 평가 중**. dynamic selector의 30은 별도 소비처(실제 진입 스케줄링/디스커버리?)에 영향 → 정확한 영향 범위 확정 후 변경.
2. **변경 방식 결정**: (a) `DEFAULT_UNIVERSE_SIZE.crypto`를 env 게이트화(예: `LUNA_CRYPTO_UNIVERSE_SIZE` 또는 기존 LIMIT 재사용) vs (b) 호출부에서 `options.universeSize` 전달. 기존 인프라 재사용 우선 검토.
3. **PROTECTED 주의**: 이건 **실제 매매 대상 종목 수**를 늘리는 직접 변경 → top volume 후보 확대보다 영향 큼. crypto LIVE 무중단 + 점진 적용 필수.

### 안건 ② 백테스팅 관련

- **unhealthy 69건 세부 분해**: 31~50위 신규 편입분 다수가 `would_block_unhealthy`로 걸림. 어떤 하위 사유(walk_forward_period_failed / sharpe_negative / drawdown_high / win_rate_low / DSR)인지 분해 → 게이트 완화 여지 분석. (세션 1 분석: crypto walk_forward는 ALL period 통과 요구라 5분봉에서 구조적으로 near-impossible. 게이트 상수 재검토 후보.)
- 게이트 상수 위치: `runtime-luna-candidate-backtest-refresh.ts` L33 (MIN_SHARPE 0, MAX_DRAWDOWN 30, MIN_WIN_RATE 30, MAX_ABS_SHARPE 8, MIN_PERIOD_TRADES 5, MIN_TOTAL_TRADES 12, periods '30,90,180'). walk_forward L655-658 (ANY period win<30 OR sharpe<0 → block). DSR L770-783 (`LUNA_DSR_GATE_ENABLED=true`, `LUNA_DSR_MIN` 0.90, `LUNA_DSR_MIN_TRADES` 30).
- 세션 1 레버 ROI 결론: 크립토 순수 단일 차단 기준 top30 유니버스 82 > DSR 4. 유니버스는 이번에 처리했으니, 다음은 **walk_forward/DSR 게이트 정밀 분석**이 남은 최대 레버.
- 국내/국외 백테스트 완화(domestic: backtest_low_trade_sample 404·insufficient_oos 331 / overseas: overfit_gap_high 165·walk_forward 155)도 별개 레버로 대기.

**진입 순서 권장**: ① dynamic selector 소비처 매핑(메티 분석) → 영향 확정 → 변경 방식 결정 → 코덱스 구현. 병행으로 ② unhealthy 69건 하위 사유 분해(메티 SQL 분석)부터 시작 가능.
