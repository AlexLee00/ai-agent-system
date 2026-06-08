# 루나 일일 투자회의 — 구현 추적 (TRACKER)

> 버전 v0.1 (2026-06-08) · 작성: 메티 · 상태: Phase 1 착수 전
> 설계 SSOT: `docs/design/LUNA_MEETING_ROOM_DESIGN.md` · 핸드오프: `docs/handoff/LUNA_MEETING_ROOM_HANDOFF.md`
> 패턴: PLATFORM_IMPLEMENTATION_TRACKER

## 범례
- 담당: **C**=코덱스(구현) · **M**=메티(설계·검증) · **마스터**=승인·커밋
- 상태: ⬜ 대기 · 🟦 진행 · ✅ 완료 · ⏸ 보류
- 검증: 문법(`node --check`) · 소프트(단위/smoke) · 하드(OPS 라이브). **메티 독립 재실행 후 PASS 선언.**

## Phase 1 — 국내·모의 (meeting-room MVP)

### WS-A 서비스/백엔드
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| `index.ts` loopback 바인딩 + Hub(:7788) 라우트 등록 | C | ⬜ | 하드: `:7788/luna/meeting` 응답 | Hub `app.ts` | P1 |
| `config/meeting.config.ts`(라운드·임계·케이던스) | C | ⬜ | 소프트: 설정 로드 | — | P1 |

### WS-B 오케스트레이터
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| `meeting-session.ts` 안건 8단계 FSM | C | ⬜ | 소프트: 전이 단위테스트 | config | P1 |
| `speaker-select.ts`(manual/auto, team-router) | C | ⬜ | 소프트: 선택 로직 테스트 | team-router | P1 |
| `action-guards.ts` ↔ autonomy-phase(L0 전결정 승인) | C | ⬜ | 소프트: L0 게이트 차단 | `shared/autonomy-phase` | P1 |

### WS-C 어댑터 (기존 호출만 · 신규 로직 금지)
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| `nodes-adapter`(l02/03/04/11/12/12b/13/14) | C | ⬜ | 소프트: 노드 호출 모킹 | `nodes/*` | P1 |
| `fundamentals-adapter`(corp_* + opendart) | C | ⬜ | 소프트: 조회 테스트 | `corp_*` | P1 |
| `order-adapter`(l31 paper + kis-client) | C | ⬜ | 하드: 모의주문 1건 | l31, kis-client | P1 |
| `rag-adapter`(l33 적재/회수) | C | ⬜ | 소프트: 적재·회수 | l33 | P1 |

### WS-D 회의록
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| `minutes/` ic-memo 경량 → PostgreSQL + RAG | C | ⬜ | 하드: 회의 1건 기록 | DB, rag-adapter | P1 |

### WS-E 웹
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| React 회의실 스캐폴드(화면 ①②) | C | ⬜ | 하드: 회의 1건 렌더 | `server/ws` | P1 |
| :7787 대시보드 상호 링크 | C | ⬜ | 소프트: 링크 동작 | :7787 | P1 |

### WS-F 데이터·규율
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| point-in-time as-of 스냅샷(opendart 수정본 방지) | C | ⬜ | 소프트: as-of 회수 | opendart | P1 |
| morning-note pre-read 생성 | C | ⬜ | 하드: pre-read 1건 | fundamentals | P1 |
| 모의 forward 실적 기록 시작 | C | ⬜ | 하드: 기록 누적 | order-adapter | P1 |

### WS-G DB·운영·규율
| 작업 | 담당 | 상태 | 검증 기준 | 의존성 | 프롬프트 |
|---|---|---|---|---|---|
| `migrations/…luna_meeting_room.sql`(sessions/messages/decisions/minutes) | C | ⬜ | 하드: 마이그레이션 적용 | PG17 | P1 |
| `ai.luna.meeting-room.plist`(비-PROTECTED) | C | ⬜ | 하드: launchd 로드 | index.ts | P1 |
| SKILL.md 컨벤션(분석가) + 자동부작용 금지 헌법 명문 | M/C | ⬜ | 소프트: 린트 | `team/*` | P1 |

## Phase 2 — 학습·데이터·헤드리스 (요약)
| 항목 | 담당 | 상태 |
|---|---|---|
| CVRF 학습층(에피소드→투자신념→노드 선택 전파) | C | ⬜ |
| napkin 실수노트(시그마 오류루프 연동) | C | ⬜ |
| CPCV + DSR/PBO/MinTRL 게이트(walk-forward 보강) | C | ⬜ |
| KRX/수급/외국인·네이버 커넥터(읽기 전용) | C | ⬜ |
| 대화형↔헤드리스 이중배포 구조 | C | ⬜ |
| 스킬 drift CI(check.py 방식) | C | ⬜ |

## Phase 3 — 자율·확장 (요약)
| 항목 | 담당 | 상태 |
|---|---|---|
| 이중 트랙 졸업 게이트 자동화 | C | ⬜ |
| 완전자율 다이얼(L2→L3) | C | ⬜ |
| LIVE 확장(국내) | 마스터 | ⬜ |
| 해외주식 확장 | C | ⬜ |
| 암호화폐 확장 | C | ⬜ |

## 재사용 vs 신규
- **재사용(수정 금지 · 호출만)**: l01~l34, `team/*`, `shared/{kis-client,autonomy-phase,dual-model-report,korea-data-promotion-gate,candidate-backtest-gate,guard-self-tuning,adaptive-cadence-resolver}`, l33-rag-store, `python/{finrl-x,quant,rl}`, korean-factor-model, opendart.
- **신규**: `services/meeting-room/*`(오케스트레이터·어댑터·minutes·ws·web·config), meeting-room migration, meeting-room plist.

## PROTECTED / LIVE 무중단 체크리스트 (모든 단계 공통)
- [ ] PROTECTED launchd(ai.{ska,luna,investment,claude,elixir,hub}.*) 중지/변경 없음
- [ ] crypto LIVE·스카 매출 경로 무영향
- [ ] LIVE 주문 경로는 기존 KIS만 · 신규 커넥터는 읽기 전용
- [ ] loopback+Tailscale 바인딩(외부 노출 없음)
- [ ] 자동 부작용(거래/이체/공시/통지) 없음 — 모두 승인 게이트
- [ ] deploy.sh / auto-commit cron 영향 확인

## 시장 확장 게이트 조건 (Phase 3)
- **국내주식**: 모의 forward 실적(post-cutoff) + 퀀트 CPCV/DSR/PBO 통과 → LIVE 승인(마스터)
- **해외주식**: 국내 LIVE 안정 + KIS 해외 어댑터 검증
- **암호화폐**: 해외 검증 + 루나 crypto LIVE 무중단 보장 하에 회의실 연결
