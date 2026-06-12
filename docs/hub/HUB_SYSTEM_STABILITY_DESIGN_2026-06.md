# Hub 시스템 안정성 설계서 (HUB_SYSTEM_STABILITY_DESIGN)

작성: 메티(Meti) / 2026-06-12
범위: Hub 전체 (LLM 라우팅 외 — 알람/제어/OAuth/Secrets/DB/launchd/프로세스 수명)
관계: LLM 라우팅은 HUB_LLM_RELIABILITY_DESIGN_2026-06.md (H 시리즈, 완료 단계) — 본 문서는 S 시리즈
추적: docs/hub/HUB_LLM_IMPROVEMENT_TRACKER.md (§L)

---

## 1. 기능 인벤토리 (소스 정밀 분석, 총 25,715줄)

| 영역 | 모듈(줄수) | 역할 |
|---|---|---|
| LLM 라우팅 | llm/ + routes/llm.ts(1,254) + unified-caller(1,192) | H 시리즈 완료 |
| 알람 | routes/alarm.ts(**1,344 — 최대**) + alarm/(roundtable 568, suppression-rules) | 수집/억제/digest/auto-repair |
| 제어 | routes/control.ts(882) + control/(tool-registry 515, agent-bus 503) | 에이전트 버스/도구 레지스트리 |
| OAuth | oauth/(routes 611, local-credentials 472, gemini-cli 468) | 3종 자격증명 수명 관리 |
| Secrets | routes/secrets.ts(517) + secrets-meta + store-monitor | 비밀 관리/모니터 |
| 안정성 리포트 | stage-b/stability.ts(912) + stage-d/production.ts(709) | launchctl/protected/circuit/budget 진단 |
| 관측 | langfuse-tracer, metrics-exporter, sentry-mcp-adapter | 트레이싱/메트릭 |
| 보안 | sql-guard, server-hardening, rate-limiters, permission-tiers, auth(timingSafeEqual) | 방어 계층 |
| 주기 작업 | launchd ai.hub.* 15종 (백업/digest/로그로테이트/oauth모니터/캐시정리 등) | 운영 자동화 |

## 2. 실측 (2026-06-12)

| 항목 | 값 | 평가 |
|---|---|---|
| 프로세스 | RSS 132MB, 타이머 3개(budget-guardian 2 + dashboard 1) | 메모리 건강, 누수 위험 낮음 |
| 수명 처리 | graceful shutdown(SIGTERM/INT) + uncaught/unhandled 오버플로 한도 후 종료 + KeepAlive 재기동 | 견고 |
| **재기동 이력** | hub.err.log에 SIGTERM 3회 — 마스터 kickstart 1회 외 **주체 불명 2회** | 거버넌스 갭 (S-4) |
| **local 회로** | `local/qwen2.5-7b CLOSED->OPEN, HALF_OPEN->OPEN(probe failed)` 고착 실측 | **S-1 긴급** |
| **알람 발송** | `[hub-alarm-client] hub alarm failed: timeout` 실측 | S-2 |
| DB 풀 | pgPool 설정 가시성 없음(기본값 추정), 알람 라우트 직접 사용 | S-3 |
| launchd 위생 | .plist.bak 6개 방치 | S-4 |

기존 강점(재확인): 알람 위생(suppression rule + dedupe 5분 + digest 라우팅 + auto-repair enqueue),
보안 기본기, provider/local 회로, stage-b 진단 리포트 — **수집·방어는 충실, "판정과 발송 신뢰성"이 갭**.

## 3. 개선 설계 — S 시리즈

### S-1 (긴급). local 회로 x on-demand 콜드스타트 충돌
- 현상: qwen2.5-7b on-demand 전환(6/11 메모리 작업) 후, 언로드 상태 첫 호출이 모델 로드(15-20s+) 중
  타임아웃 -> 3연속 실패 -> 회로 OPEN -> HALF_OPEN probe도 같은 이유로 실패 -> **OPEN 고착**.
- 영향: H2-c 이후 local의 유일한 정당 용처인 backtest_* 경로가 차단될 수 있음 (chronos backtest LLM 품질 샘플 등).
  local-embedding(별도 회로 키)은 영향 범위 별도 확인.
- 설계: (a) local 회로 한정 콜드스타트 인지 — 첫 시도 timeout을 로드 여유(기본 180s, env)로 분리하거나
  mlx-server 'loading' 응답을 실패로 계수하지 않음. (b) HALF_OPEN probe에 사전 워밍업 핑(빈 completion) 적용.
  (c) env: `HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS` (기본 180_000).
- 검증: 언로드 상태에서 backtest judgment 1건 -> 회로 OPEN 없이 성공.

### S-2. 알람 발송 신뢰성 (최후 방어선)
- 현상: alarm-client timeout 실측 — 발송 실패가 조용히 유실되면 장애를 모름.
- 설계: 경량 outbox — 발송 실패 시 hub DB 테이블(alarm_outbox)에 적재 + 주기 재시도(기존 launchd
  alarm-stale-auto-repair에 통합 가능) + 실패 카운터를 /hub/health에 노출. 스톰 시 digest 강제 전환(기존 메커니즘 재사용).
- 외부 정합: transactional outbox 패턴 (메시지 신뢰성 표준).

### S-3. DB 풀 가시성/한도
- 설계: pgPool 생성부에 max/idleTimeout/connectionTimeout 명시(env) + /hub/health에
  pool {total,idle,waiting} 노출 + waiting>0 지속 시 경고. 코드 변경 소규모.

### S-4. 운영 거버넌스/위생
- 재기동 감사: gracefulShutdown에 호출 맥락 기록(신호 수신 시각, ppid) + hub_events 적재 -> 주체 불명 재기동 추적.
- .plist.bak 6개 -> docs/archive/launchd-bak/ 이동 (마스터).
- (확인 필요) 5분 deploy cron이 hub 재기동을 트리거하는지 추적 — SIGTERM 2회의 유력 후보.

### S-5. Hub 자체 건강 게이트 (H6 패턴 확장 — GATE-S)
- stage-b 리포트는 풍부하나 "판정"이 없어 마스터가 직접 읽어야 함.
- GATE-S: 24h 창 — uncaught/unhandled 수, 알람 발송 실패율, 풀 waiting, 회로 OPEN 누적 시간, 재기동 횟수
  -> ready/degraded 판정 + degraded 시 알람. hub-llm-promotion-gate에 게이트 1종 추가로 구현(인프라 재사용).

### S-6 (중기/보류). 단일 프로세스 SPOF
- graceful+KeepAlive로 재기동 갭은 수 초 — 단일 머신 제약상 멀티 인스턴스는 과설계.
  무중단 재기동(소켓 드레인 보장)만 R 시리즈 이후 검토. 지금은 비조치 결정.

## 4. 외부 사례 정합 (2026-06-12 GitHub API 실조회)
- **LiteLLM (★50,155)**: cooldown/allowed_fails/healthy_deployments — H1-a로 이식 완료. S-1은 동일 사상의 local 특수화.
- **TensorZero (★11,460)**: 글로벌/모델/프로바이더 계층 timeout — H3(동적 예산)에서 반영 예정.
- OpenAI/Anthropic SDK 표준: 429/5xx 차등 재시도 + Retry-After — H1-a 반영 완료.
- Transactional Outbox(메시징 신뢰성 표준 패턴): S-2.
- Node 프로덕션 체크리스트(graceful/health/circuit/rate-limit): Hub는 대부분 충족 — 갭은 판정(S-5)과 발송(S-2).

## 5. 통합 로드맵 (2026-06-12 재설계 — P/H/R/S 전 시리즈)

| 순번 | 단계 | 내용 | 상태 | 게이트 |
|---|---|---|---|---|
| 0 | P1~P4 + H1/H2/H5/H6 + TS-L1 | 코드리뷰 + LLM 신뢰성 + 자동승급 게이트 | **완료** (커밋은 마스터 확인) | TS-1~16 PASS |
| 1 | **CODEX-S1** local 콜드스타트 회로 보정 | S-1 — backtest 경로 보호 | **긴급, 즉시** | 언로드 상태 judgment 성공 |
| 2 | GATE-H evidence ready | 168h 창 정화 대기 | ~6/18 자동 (6/14 --hours=48 선행) | GATE-H |
| 3 | CODEX-S2+S3 | 알람 outbox + 풀 가시성 | GATE-H ready 후 | 발송 실패율 지표 |
| 4 | CODEX-H3 | 동적 timeout/출력 예산 (섀도->활성) | S 안정화 후 | GATE-H3 |
| 5 | R1 정책 엔진 설계 | 스키마 + 전수 스냅샷 (분산 해소) | 메티 설계서 | 마스터 승인 |
| 6 | CODEX-R2~R4 | 엔진 + shadow diff=0 + 팀별 전환 + 레거시 소거 | R1 승인 후 | GATE-R |
| 7 | S-4/S-5 | 재기동 감사 + GATE-S | R과 병행 가능 | GATE-S 신설 |
| 8 | S-6 | 무중단 재기동 검토 | 보류 (비조치 결정) | - |

원칙 유지: 게이트 기반 자동 판정(H6 패턴) — 마스터는 ready 신호와 승인만. 모든 변경은 flag/킬스위치 동반.

## 6. 마스터 결정 포인트
1. CODEX-S1 즉시 착수 승인 (backtest 경로 차단 위험 — 메티가 프롬프트 작성)
2. S-4의 .bak 정리 + 재기동 주체(5분 deploy cron 여부) 확인
3. R1 착수 시점: GATE-H ready(~6/18) 전이라도 설계(문서)는 병행 가능 — 병행 여부

---

## 7. 테스트 시나리오 (정식 원천 — S 시리즈, CODEX-S* 검증 기준)

형식: Given/When/Then. H 시리즈의 TS-1~16은 HUB_LLM_RELIABILITY_DESIGN §8이 원천이며,
S 시리즈는 본 §7이 원천이다. 코덱스 자가검증과 메티 독립 검증 모두 동일 TS-ID로 보고. 추적: TRACKER §F.

### S-1 콜드스타트 회로 (CODEX-S1)
| ID | Given | When | Then |
|---|---|---|---|
| TS-S1-1 | qwen2.5-7b 언로드(on-demand idle) + local 회로 CLOSED | backtest_* taskType local 호출 1건 | 로드 대기 후 성공, 회로 OPEN 전이 없음 |
| TS-S1-2 | 콜드스타트 진행 중(로드 15-20s) | 회로 실패 판정 | 콜드스타트 타임아웃(HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS, 기본 180s) 적용 — 일반 타임아웃으로 실패 계수 금지 |
| TS-S1-3 | 킬스위치 env=false | 동일 호출 | 현행 동작(기존 타임아웃/회로) 복귀 |
| TS-S1-4 | local-embedding 경로 | S-1 변경 후 호출 | 무영향 (별도 회로 키 비접촉) |
| TS-S1-5 | OPEN 고착 상태(현 실측) | HALF_OPEN probe | 워밍업 인지 probe로 CLOSED 복귀 가능 |

### S-2 알람 outbox (CODEX-S2)
| ID | Given | When | Then |
|---|---|---|---|
| TS-S2-1 | 알람 발송 대상 비가용(timeout) | 발송 시도 | alarm_outbox 적재 + 호출 흐름 비차단 |
| TS-S2-2 | outbox에 미발송 건 존재 | 재시도 주기 실행 | 발송 성공 시 outbox 해소, 실패 시 잔존+카운터 |
| TS-S2-3 | - | GET /hub/health | 알람 발송 실패 카운터 노출 |

### S-3 풀 가시성 (CODEX-S2에 동반)
| ID | Given | When | Then |
|---|---|---|---|
| TS-S3-1 | - | GET /hub/health | pool {total,idle,waiting} 노출 |
| TS-S3-2 | env로 max/timeout 지정 | 풀 생성 | 명시값 적용 (기본값은 현행 유지) |

### S-4 재기동 감사
| ID | Given | When | Then |
|---|---|---|---|
| TS-S4-1 | SIGTERM 수신 | graceful shutdown | 로그에 수신 시각+호출 맥락(ppid) 기록 |

### S-5 GATE-S (H6 패턴 상속)
| ID | Given | When | Then |
|---|---|---|---|
| TS-S5-1 | 24h 창 지표 임계 초과(mock) | 게이트 실행 | status=degraded + 알람 페이로드 |
| TS-S5-2 | 지표 정상(mock) | 게이트 실행 | status=ready |
| TS-S5-3 | --apply | 실행 | 영구 차단 (H6 동일 — promotionReady류 하드코딩) |

### 라이브 단계
| ID | 시점 | 기준 |
|---|---|---|
| TS-SL1 | CODEX-S1 적용 후 | 언로드 상태에서 실제 backtest judgment 1건 성공 + 회로 로그에 OPEN 전이 없음 |
| TS-SL2 | S2/S3 적용 +48h | 알람 발송 실패 카운터 안정 + pool waiting=0 유지 |
