# 회의실 웹 테스트 시나리오 (http://127.0.0.1:7791)

> v1.0 (2026-06-12) · 작성: 메티 · 대상: MR-B 웹 + FIX2~4 반영분 · SSOT: LUNA_MEETING_ROOM_DESIGN.md(v0.8)
> 표기: **[자동]**=스모크(`check:luna-meeting-room-web` 등) 커버 / **[수동]**=브라우저 점검 필요(자동화 후보) / 🔁=정례 점검(회의 사이클마다)
> 이력: 마스터 수동 점검으로 발견·종결 3건 — 마크다운 원문 노출(FIX2)·JSON 덤프(FIX3)·서킷 카운트 3배 과대(FIX4). 본 문서는 그 재발 방지 체계화.

## A. 화면① 일일 회의실
| ID | 시나리오 | 절차 | 기대 결과 | 커버 |
|---|---|---|---|---|
| W-01 | 초기 로드 | 접속 | 3컬럼(목록·타임라인·결정 대기함)+상단 배지(ADVISORY/SHADOW)+:7787 링크와 상태/새창 aria+화면 전환 tablist/tabpanel+방향키/Home/End 전환 | [자동] header/tab a11y+[수동] ✅2026-06-12 브라우저 |
| W-02 | U1 캐치업 | 회의 선택 | 상단 3줄: 확정 n·보류 m·대기 k·마스터 액션 필요, 동적 갱신은 live region으로 전달, 보조기술에서 줄 단위로 구분 가능 | [자동] catchup API+live region/list a11y+[수동] ✅2026-06-12 표시 |
| W-03 | 타임라인 role 구분 | 회의 선택 | 시스템/데이터/분석/그릴/결정/ADR 색 보더·범례·seq 순서·minute별 aria-label | [자동] ADR 클래스+timeline a11y+role legend+[수동] ✅브라우저 |
| W-04 | 회의 시작(정상) | 타입 선택→시작 | 진행 상태 폴링→완료 후 실제 세션 타임라인으로 전환, 시작 컨트롤/목록 선택 상태 aria 제공, 회의 목록 region/list 구조 유지, 실행 실패 시 오류 원인 표시 | [자동] start API+completed/failed run 전환+a11y |
| W-05 | 회의 시작(중복) | open 세션 중 재시작 | 409 + 사용자 메시지(중복 안내) | [자동] 409+친화 메시지 문자열 |
| W-06 | 휴장 비활성 | 주말에 debrief 선택 | 비활성 선택지+세그먼트 상태 배지+사유 툴팁+select와 상태 설명 연결+선택 타입 비활성 시 시작 버튼 차단 | [자동]+[수동] ✅fixture 브라우저 |
| W-07 | LLM 토글 | "LLM 발언 사용" 해제→시작 | --no-llm 경로(발언=결정론)·비용 0 + 현재 모드 명시·토글 상태 변경 live region 전달 | [자동] 기본 noLlm payload+mode live region+[수동] ✅토글 표시 |
| W-08 | 결정 confirm | 카드에서 확정(+감사 메모) | status=confirmed·카드 이동/배지·minutes 감사 행, 결정 대기함 live region 갱신, 사용자 화면은 한국어 상태 라벨 우선 | [자동] API+pending region+[수동] ✅fixture 브라우저 |
| W-09 | 결정 defer | 보류 | status=deferred 동일 검증, 결정 카드별 aria-label, 내부 상태 토큰은 title/evidence로만 보존 | [자동]+[수동] ✅fixture 브라우저 |
| W-10 | 이중 처리 멱등 | 같은 결정 재confirm(웹+텔레그램 교차 포함) | "이미 처리됨" 안내·상태 불변 | [자동] API+웹 notice+[수동] 교차 |
| W-11 | due 표시 | due 임박/경과 결정 | 배지 강조(경과=시각 구분)+기한 상태 title/aria-label | [자동] dueState+a11y+[수동] ✅2026-06-12 |
| W-12 | evidence 펼침 | `근거 JSON 보기` 클릭 | JSON `<pre>` 표시(이건 의도 — 머신리더블 보존), 모바일 overflow 없음(`pre` horizontal containment), 컨트롤별 결정 ID aria-label | [자동] 라벨/accessibility+overflow guard+[수동] ✅390px 펼침 |

## B. 렌더 품질 (FIX2~4 회귀 — 🔁 매 회의 후 1회 점검)
| ID | 시나리오 | 기대 결과 | 커버 |
|---|---|---|---|
| W-20 | 마크다운 4종 | `**볼드**`·`###`·`- 리스트`·`\|표\|`가 서식 렌더(원문 기호 노출 없음), 좁은 폭 표 cell 래핑 | [자동] smoke+table wrap guard+[수동] 🔁 |
| W-21 | JSON 덤프 부재 | 발언 content에 `{...}` 원문 없음(C15 대기·서킷 안건 한국어 요약) | [자동] legacy API 정규화+브라우저 ✅ |
| W-22 | 서킷 distinct | "활성 잠금 N건"이 고유 잠금 수(DB distinct 쿼리와 일치) | [자동] smoke+[수동] ✅2026-06-12 세션 #1 서킷=3건 |
| W-23 | XSS 회귀 | `<script>` 포함 텍스트가 문자 그대로(미실행)·innerHTML 0 | [자동] smoke |
| W-24 | LLM 발언 품질 | 번역투("하트")·동일 문단 반복 없음·status 값 halt/reduced/full 원문 유지·entry/프록시/진입 용어 표시 보정·halt를 가치판단으로 오해하지 않음 | [자동] 반복 표시 축약+status/용어 복원+진입/게이트 용어 보정+[수동] 🔁 다음 실회의 |

## C. 화면② 에이전트 질의
| ID | 시나리오 | 기대 결과 | 커버 |
|---|---|---|---|
| W-30 | @멘션 질의 | 에이전트 선택+질문→응답 스레드(advisory 라벨·provider 표기·호출 비용/한도 안내·한국어 필드 라벨·입력 전후 버튼 안내·응답 live region·질의 중 aria-busy·한국어 응답 메타·새 질의 시 이전 응답 제거·입력 변경 시 이전 오류 제거) | [자동] 안전 안내/라벨/입력 안내/live/busy/meta/stale 제거+[수동] ✅UI 기본 상태·실호출 보류 |
| W-31 | 비용 가드 | 분당 2회 초과→429 안내(분 경과 후 재시도 가능) | [자동] API |
| W-32 | 응답 마크다운 | LLM 응답의 마크다운도 W-20과 동일 렌더 | [자동] fixture+[수동] 실호출 보류 |

## D. 통신·보안·내성
| ID | 시나리오 | 기대 결과 | 커버 |
|---|---|---|---|
| W-40 | 폴링 주기 | open 세션 시 3초·idle 30초(네트워크 탭 확인) | [자동] cadence 계약+[수동] 네트워크 탭 |
| W-41 | 서버 다운 내성 | 서버 중지 상태에서 조작 | 에러 안내(빈 화면/무한 로딩 금지)·재기동 후 자동 회복·실패 시 오래된 회의/결정 데이터 제거 | [자동] 복구시 에러 clear+stale 제거+[수동] fixture |
| W-42 | 바인딩 | `lsof -i :7791` → 127.0.0.1 한정(0.0.0.0 아님) | [자동] smoke |
| W-43 | 토큰 | MEETING_ROOM_TOKEN 설정 시 무토큰 401·정상 토큰 200 | [자동] |
| W-44 | 모바일 반응형/키보드 | 창 폭 축소·Tab 이동 | 1컬럼 전환(grid 1fr)·버튼 탭 가능 크기·명시적 `focus-visible` 링 | [자동] focus ring+[수동] ✅390px 확인 |

## E. 정례 연동 (🔁 자동 회의 사이클 — 토 05:00 첫 사이클부터)
| ID | 시나리오 | 기대 결과 | 커버 |
|---|---|---|---|
| W-50 | 자동 회의 반영 | 정례 회의 후 접속 | 목록에 새 세션·캐치업 갱신·새 pending 카드 | [자동] run 완료 후 새 세션 반영+[수동] 🔁 정례 launchd |
| W-51 | 텔레그램↔웹 동기 | 텔레그램 버튼으로 confirm 후 웹 확인 | 카드 상태 일치+감사 행 changed_via=telegram | [자동] callback/action smoke+[수동] 🔁 첫 실버튼 |
| W-52 | 주말 경량판 | 토/일 morning 회의록 | 국내·미국 "스킵(주말)"·crypto만 실안건 | [자동] weekend dry-run+[수동] 🔁 실제 주말 |
| W-53 | regenerate 일치 | `--regenerate=<id>` md vs 웹 타임라인 | 내용 동일(DB 단일 소스) | [수동] ✅2026-06-12 세션 #1 counts 일치 |

## 루프 피드백 로그
- **2026-06-12 루프 1**: 브라우저에서 기존 회의 #1 선택 시 legacy C15 JSON 덤프와 과거 서킷 57건 표기가 노출됨 → API 표시 레이어에서 C15 raw JSON을 한국어 요약으로 정규화하고 legacy 중복 집계 숫자를 숨김. `check:luna-meeting-room-web`에 `legacyRawJsonMinuteNormalized`, `legacyCircuitCountMasked` 추가.
- **2026-06-12 루프 2**: 첫 로드 UX와 due/에러 메시지 점검 → 최신 회의 자동 선택 직후 상세 fetch, 상세 로딩 상태, due 임박/경과 배지, 409/429/서버연결 실패 친화 메시지 추가. 브라우저 390px 모바일 확인: 1컬럼·overflow 없음·버튼 높이 42px 이상.
- **2026-06-12 루프 3**: ADR minute가 일반 decision과 구분되지 않는 표시 위험 보강 → speaker/role이 `adr`인 minute는 `ADR` 라벨과 별도 보더/배경을 사용하도록 하고 스모크에 `adrRolePresentation` 추가.
- **2026-06-12 루프 4**: 실제 #1 회의에서 sophia 발언의 반복 결론 문단 확인 → 향후 LLM 프롬프트에 반복 결론/필러 금지를 추가하고, 기존 minute 표시 계층에서 반복 결론 블록을 축약하는 스모크 `repetitiveLlmMinuteCompacted` 추가.
- **2026-06-12 루프 5**: in-memory 브라우저 fixture로 confirm/defer UI 흐름 검증 → 카드 제거·감사 minute·pending 비움은 정상이나 catchup이 deferred를 숨겨 `결정됨 1건`만 표시하던 문제 발견. 요약을 `확정/보류/대기`로 분리하고 스모크 `catchupConfirmedDeferredPendingCounts` 추가.
- **2026-06-12 루프 6**: W-41 관점에서 서버 장애 후 복구 경로 점검 → 네트워크 에러 메시지는 존재하지만 성공 refresh 후 오류 배너가 남을 수 있어 `refreshBase/refreshSelected` 성공 시 `setError('')`를 호출하도록 보강. 스모크 `serverRecoveryClearsError` 추가.
- **2026-06-12 루프 7**: W-06 휴장 UX 점검 → disabled `<option>`만으로는 사유 발견성이 낮아 시작 폼에 시장 세그먼트 상태 배지를 추가. fixture에서 국내 `weekend` 비활성 사유가 배지/tooltip/disabled option으로 보이는지 검증하고 스모크 `closedSegmentReasonVisible` 추가.
- **2026-06-12 루프 8**: W-07 LLM 토글 비용 인지성 보강 → 체크박스 아래에 `결정론 발언 · LLM 비용 0`/`LLM 발언 사용 · 비용 가드 적용` 현재 모드 배지를 추가하고, start payload 기본값이 `noLlm=true`인지 스모크 `llmToggleDefaultNoCost`로 검증.
- **2026-06-12 루프 9**: 실제 회의 #1의 분석 minute에서 `halt/reduced/full`이 `중단/감소/전체`로 번역된 표현을 확인 → DB 원문은 보존하되 표시 API에서 게이트/시장 상태 문맥만 canonical token으로 복원. 스모크 `canonicalStatusTokensPreserved` 추가.
- **2026-06-12 루프 10**: W-12 evidence 펼침 점검 → 기능은 동작하지만 summary가 영어 `evidence`라 한국어 UI 흐름에서 발견성이 낮음. `근거 JSON 보기`로 라벨을 변경하고 스모크 `evidenceDisclosureKoreanLabel` 추가.
- **2026-06-12 루프 11**: W-30 에이전트 질의 화면 점검 → 제출 전 advisory/비용/분당·일일 한도 안내가 부족함. 질의 폼에 `advisory only · LLM 호출 비용 가능 · 분당 2회 / 일 20회 한도` 안내를 추가하고 스모크 `askSafetyNotice` 추가.
- **2026-06-12 루프 12**: W-40 폴링 계약 점검 → open/running 회의는 3초, idle은 30초 폴링이어야 하므로 웹 스모크에 `run.status === 'running'`과 `hasOpen ? 3000 : 30000` 계약 검증 `pollingCadenceConfigured` 추가.
- **2026-06-12 루프 13**: W-53 regenerate 일치 점검 → `runtime-luna-meeting-room.ts --regenerate=1 --json` 결과와 `/api/meetings/1`을 비교해 session=1, minutes=56, decisions=9가 동일함을 확인. 생성 markdown은 `bots/investment/output/meeting-room/` gitignored 산출물.
- **2026-06-12 루프 14**: W-22/W-24 동시 점검 → 세션 #1 데이터 minute의 distinct 서킷은 3건으로 정상. 단 과거 LLM minute에 `halt`가 `'할당' 상태`로 번역된 표현이 남아 있어 게이트/시장 상태 문맥의 표시 정규화에 `할당 상태 → halt 상태`를 추가하고 스모크 검증을 확장.
- **2026-06-12 루프 15**: W-10 교차 멱등 UX 점검 → API는 idempotent지만 stale 웹 카드가 텔레그램/다른 탭 처리 뒤 응답을 받으면 조용히 refresh만 할 수 있음. idempotent 응답 시 `이미 처리된 결정입니다. 최신 상태로 갱신했습니다.` notice를 표시하도록 보강하고 스모크 `idempotentDecisionNotice` 추가.
- **2026-06-12 루프 16**: W-51 경로 점검 → `check:luna-meeting-room-c`로 텔레그램 callback parser/router와 `applyMeetingDecisionAction(changed_via=telegram)` smoke 통과 확인. 실제 텔레그램 버튼 클릭의 웹 반영은 첫 실사용 시 수동 검증으로 유지.
- **2026-06-12 루프 17**: W-04/W-50 실행 반영 경로 점검 → 완료된 run이 `activeRuns`에 남아 있으면 UI가 run 상태 카드에 머물고 실제 session minutes로 자동 전환되지 않을 수 있음. `payload.run.status==='completed' && sessionId`이면 실제 세션 상세로 전환하도록 보강하고, run 완료 후 `/api/meetings` 최신 세션과 `/api/catchup/<session>` 반영을 스모크 `completedRunSwitchesToSessionDetail`로 검증.
- **2026-06-12 루프 18**: W-50 목록 누적 UX 점검 → 완료된 run을 `/api/meetings.activeRuns`에 계속 노출하면 정례 회의 반복 시 완료 run 카드가 누적될 수 있음. 목록 API는 `running` run만 노출하고, 완료 run은 `/api/meetings/<runId>` 상세 조회만 유지하도록 보강. 스모크에서 완료 후 `activeRuns.length=0`과 실제 최신 session 반영을 함께 검증.
- **2026-06-12 루프 19**: W-52 주말 경량판 자동화 → `2026-06-13` 주말 시점의 plan-note로 `runMeetingSession(noLlm,dryRun)`을 실행해 국내/미국 data minute는 `스킵(weekend)`, crypto data minute는 `진행`, crypto market decision은 1건 생성됨을 스모크 `weekendLightweight`로 고정.
- **2026-06-12 루프 20**: 실제 브라우저 DOM 감사로 W-24 LLM 표시 품질을 재점검 → legacy sophia 발언에 `프로ksi/프로끼`, `전략군 입장`, 후행 `중단 상태`가 남는 문제 확인. DB 원문은 보존하고 표시 API에서 `프록시`, `진입`, `halt 상태`로 정규화하도록 보강했으며 `check:luna-meeting-room-web` fixture에 회귀 케이스를 추가. 재시작 후 브라우저에서 금지 문구 부재와 `진입 없음/프록시` 표시를 확인.
- **2026-06-12 루프 21**: W-08/W-09 결정 대기 카드 UX 점검 → 실제 카드가 `c_master/pending_master`와 `confirm/defer` 원문만 노출해 마스터 액션 인지성이 낮음. 원문 토큰은 괄호로 보존하되 `C 마스터 확인`, `마스터 액션 대기`, `확정`, `보류`, `감사 메모` 라벨을 추가하고 브라우저에서 영어 버튼 미노출과 한국어 상태/버튼 표시를 확인. 스모크 `decisionActionKoreanLabels` 추가.
- **2026-06-12 루프 22**: W-12 모바일/evidence 접근성 점검 → 390px에서 evidence `<pre>`를 펼쳐도 horizontal overflow는 없었음. 다만 결정 카드마다 `확정/보류/근거 JSON 보기/감사 메모` accessible name이 반복돼 키보드·스크린리더 사용자가 대상 결정을 구분하기 어려움. 각 컨트롤에 `결정 #id ...` aria-label을 추가하고 브라우저 DOM에서 `결정 #1 확정/보류/감사 메모/근거 JSON 보기` 반영을 확인. 스모크 `decisionControlsAccessibleNames` 추가.
- **2026-06-12 루프 23**: W-30 에이전트 질의 화면 점검 → 실제 브라우저에서 필드 라벨이 `agent/question` 영어로 남아 운영 UI 문맥과 맞지 않음. `에이전트`, `질문` 라벨과 `질의 대상 에이전트`, `회의실 컨텍스트 기반 advisory 질문` aria-label을 추가하고 브라우저에서 영어 라벨 부재·한국어 라벨/aria 반영을 확인. 스모크 `askFormKoreanLabels` 추가.
- **2026-06-12 루프 24**: W-30 입력 전후 흐름 점검 → 질문 입력 전 버튼은 disabled이고 비용 안내는 보이지만, 왜 비활성인지와 응답 영역의 다음 행동 안내가 약함. `질문을 입력하면 전송 버튼이 활성화됩니다.`, `아직 응답 없음 · 질문을 입력한 뒤 질의 보내기를 누르세요.`, 버튼 title/aria를 추가하고 브라우저에서 입력 전 disabled·입력 후 enabled·title 전환을 확인. 스모크 `askInputGuidance` 추가.
- **2026-06-12 루프 25**: W-43/헤더 접근성 점검 → 헤더 토큰 입력이 `MEETING_ROOM_TOKEN` 기술명만 노출되고 일반 텍스트 input이라 토큰이 화면에 그대로 보일 수 있음. `접근 토큰 (MEETING_ROOM_TOKEN)`, `type=password`, `autocomplete=off`, `회의실 접근 토큰` aria-label을 추가. 탭 버튼에는 선택 상태 `aria-pressed`를 추가하고 브라우저에서 일일 회의실=true, 에이전트 질의=false를 확인. 스모크 `headerTokenA11y`, `tabPressedState` 추가.
- **2026-06-12 루프 26**: W-04 회의 시작/목록 접근성 점검 → 회의 타입 select, 시작 버튼, LLM 토글, 회의 목록 item에 aria 정보가 부족함. `시작할 회의 타입`, 타입별 시작 버튼 aria/title, LLM 모드 describedby, 회의 목록 `aria-pressed`/상세 aria-label을 추가. 브라우저에서 `아침 통합 회의 시작`, `meeting-llm-mode`, `회의 #1 morning closed 선택` 반영 확인. 스모크 `startMeetingA11y`, `meetingListPressedState` 추가.
- **2026-06-12 루프 27**: W-03 타임라인 탐색성 점검 → 긴 회의록 article이 시각적으로는 구분되지만 스크린리더가 minute 번호/역할/안건을 빠르게 식별할 aria-label이 없음. 타임라인 card를 `role=region aria-label=회의 타임라인`으로 지정하고 각 article에 `N번 minute · agenda · 역할 · speaker` aria-label을 추가. 브라우저에서 `1번 minute · session · 시스템 · system`, `2번 minute · market:domestic · 데이터 · stack-adapter` 반영 확인. 스모크 `timelineArticleA11y` 추가.
- **2026-06-12 루프 28**: W-02/W-41 동적 상태 전달 점검 → U1 캐치업은 회의 선택·폴링·완료 전환 시 계속 바뀌지만 live region이 없어 보조기술 사용자에게 변경이 전달되지 않음. 캐치업 영역에 `role=status`, `aria-live=polite`, `aria-label=U1 캐치업 요약`을 추가하고 error는 `role=alert aria-live=assertive`, notice는 `role=status aria-live=polite`로 고정. 브라우저에서 캐치업 live region 반영 확인. 스모크 `dynamicRegionA11y` 추가.
- **2026-06-12 루프 29**: W-08/W-09 결정 대기함 동적 영역 점검 → 확정/보류 후 카드가 제거되는 핵심 영역인데 region/list/live semantics와 카드별 aria-label이 없음. 결정 대기함을 `role=region`, 목록을 `role=list aria-live=polite`, 카드를 `role=listitem` 및 `결정 #id · agenda · 등급 · 상태 · due` aria-label로 보강. 브라우저에서 `pending_master 결정 9건`, `결정 #1 · market:domestic · C 마스터 확인 · 마스터 액션 대기` 반영 확인. 스모크 `decisionRegionA11y` 추가.
- **2026-06-12 루프 30**: W-12 모바일 evidence 펼침 재점검 → 390px에서 현재 fixture evidence는 overflow가 없지만 `<pre>`의 `overflow-x`가 `visible`이라 긴 JSON/URL evidence가 들어오면 카드 밖으로 밀릴 수 있음. `pre { max-width:100%; overflow-x:auto; }`를 추가해 머신리더블 JSON은 보존하면서 horizontal containment를 명시. 브라우저에서 390px evidence 펼침 시 body horizontal overflow 없음, 스모크 `evidencePreMobileOverflowGuard` 추가.
- **2026-06-12 루프 31**: W-30/W-32 에이전트 질의 응답 영역 점검 → 질문 응답은 비동기 LLM/Hub 결과로 바뀌지만 `.answer` 영역에 live region semantics가 없어 응답 도착이 보조기술 사용자에게 전달되지 않음. 응답 영역을 `role=status aria-live=polite aria-label=에이전트 질의 응답`으로 보강하고 브라우저에서 빈 응답 상태에 live region 반영을 확인. 스모크 `askAnswerLiveRegion` 추가.
- **2026-06-12 루프 32**: W-07 LLM 토글 상태 전달 점검 → 토글 체크 시 `결정론 발언 · LLM 비용 0`에서 `LLM 발언 사용 · 비용 가드 적용`으로 문구는 바뀌지만 live region이 없어 상태 변경 전달이 약함. `meeting-llm-mode`를 `role=status aria-live=polite aria-label=LLM 발언 모드`로 보강하고 브라우저에서 토글 전후 문구와 live 속성 반영을 확인. 스모크 `llmModeLiveRegion` 추가.
- **2026-06-12 루프 33**: W-06 휴장 비활성 사유 전달 점검 → disabled option은 라벨에 사유가 붙지만 select가 세그먼트 상태 설명과 연결되지 않고 option/title/aria 사유가 약해 키보드·스크린리더 사용자가 휴장 사유를 놓칠 수 있음. select를 `meeting-segment-status`와 `aria-describedby`로 연결하고 세그먼트 상태를 `role=status aria-live=polite`, disabled option/pill에 사유 title·aria-label을 추가. 스모크 `closedSegmentReasonA11y` 추가.
- **2026-06-12 루프 34**: W-20 마크다운 표 모바일 내성 점검 → 현재 실회의에는 표가 없어 overflow 재현은 없었지만, 표 CSS가 `overflow:hidden` 중심이고 cell 단위 긴 토큰 래핑 방어가 없어 향후 긴 심볼/URL/JSON 키가 들어오면 좁은 폭에서 레이아웃을 밀 수 있음. `.markdown-table`에 `max-width:100%; table-layout:fixed`, cell에 `overflow-wrap:anywhere; word-break:break-word`를 추가. 스모크 `markdownTableMobileWrapGuard` 추가.
- **2026-06-12 루프 35**: W-01 초기 로드 헤더 접근성 점검 → 상단 MR-B/advisory/shadow/localhost pill은 의미 있는 상태지만 role/aria가 없고, TeamJay Dashboard 링크는 새 창으로 열리는데 목적/새창 안내가 없음. topline을 `role=status aria-label=회의실 실행 상태`로 묶고 pill별 aria-label, Dashboard 링크 aria/title을 추가. 브라우저에서 `TeamJay Dashboard 7787 새 창으로 열기` 및 로컬 바인딩 aria 반영 확인. 스모크 `headerStatusAndDashboardA11y` 추가.
- **2026-06-12 루프 36**: W-03 타임라인 역할 구분 점검 → minute별 border-left 색상과 aria-label은 존재하지만 색상 의미를 설명하는 범례가 없어 시각적 role 구분을 즉시 해석하기 어려움. 타임라인 상단에 `타임라인 역할 색상 범례` list를 추가하고 시스템/데이터/분석/그릴/결정/ADR dot+label을 표시. 브라우저에서 role legend와 기존 minute별 보더/aria-label 유지 확인. 스모크 `timelineRoleLegend` 추가.
- **2026-06-12 루프 37**: W-11 due 배지 접근성 점검 → 실제 브라우저에서 `due soon` 배지는 보이지만 `title`/`aria-label`이 없어 임박·경과·확인 필요 의미가 색상과 짧은 텍스트에만 의존함을 확인. `dueState`가 `기한 임박/경과/정상/확인 필요` 설명을 반환하게 하고 배지에 `title`과 `aria-label`을 부여. `unknown` 상태 CSS와 스모크 `dueBadgeA11y` 추가.
- **2026-06-12 루프 38**: W-44 키보드 내비게이션 점검 → 현재 전역 스타일에는 명시적 `focus-visible` 계약이 없어 브라우저/OS 기본 포커스 표시에 의존함. 버튼·입력·select·textarea·링크·summary에 3px outline과 보조 box-shadow를 추가해 키보드 사용자가 현재 위치를 안정적으로 식별하도록 보강. 스모크 `keyboardFocusVisible` 추가.
- **2026-06-12 루프 39**: W-30 에이전트 질의 진행 상태 점검 → 버튼은 `질의 중`으로 바뀌지만 응답 영역에 `aria-busy`가 없어 비동기 Hub/LLM 호출 대기 상태 전달이 약하고, 이전 응답이 남아 있으면 새 질의 진행 상태가 모호할 수 있음. 응답 live region에 `aria-busy=${busy}`를 추가하고 busy 중에는 `질의 중 · 에이전트 응답을 기다리는 중입니다.` 문구를 표시하도록 보강. 스모크 `askBusyStatus` 추가.
- **2026-06-12 루프 40**: W-30 에이전트 응답 메타 표시 점검 → 응답 카드 메타가 `ok=true` 같은 내부 필드를 그대로 노출해 운영자가 성공/실패 상태를 빠르게 읽기 어렵고 한국어 UI 흐름과도 맞지 않음. `에이전트 luna · 제공자 fixture · 상태 성공/실패/확인 필요` 형태로 표시를 바꾸고 원시 `ok=` 노출을 제거. 스모크 `askResponseMetadataLabels` 추가.
- **2026-06-12 루프 41**: W-01/W-30 화면 전환 semantics 점검 → 실제 브라우저에서 `일일 회의실/에이전트 질의`는 탭처럼 동작하지만 `tablist/tab/tabpanel` role, `aria-selected`, `aria-controls`가 없어 보조기술에는 일반 버튼 2개로만 전달됨. 기존 `aria-pressed`는 유지하면서 `role=tablist`, 각 버튼 `role=tab`, 활성 패널 `role=tabpanel aria-labelledby`를 추가. 스모크 `tablistSemantics` 추가.
- **2026-06-12 루프 42**: W-01 화면 전환 ARIA 구조 재점검 → 루프 41의 `tablist`가 Dashboard 링크까지 포함해 탭 목록 내부에 비-tab 링크가 들어가는 구조적 문제가 확인됨. 시각 행은 유지하되 `.tab-switcher`만 `role=tablist`로 분리하고 Dashboard 링크는 형제 요소로 이동. 브라우저에서 tablist 직계/하위 탭 2개와 Dashboard 링크 분리 확인.
- **2026-06-12 루프 43**: W-01 화면 전환 키보드 조작 점검 → `tablist` semantics는 있으나 방향키/Home/End 처리와 roving `tabIndex`가 없어 키보드 사용자는 두 탭을 일반 버튼처럼 순차 탐색해야 함. 선택 탭만 `tabIndex=0`, 비선택 탭은 `-1`로 두고 ArrowLeft/ArrowRight/ArrowUp/ArrowDown/Home/End로 탭과 패널을 전환하도록 보강. 스모크 `tabKeyboardNavigation` 추가.
- **2026-06-12 루프 44**: W-06 휴장/비활성 회의 시작 가드 점검 → 세그먼트 상태가 갱신되어 현재 선택된 회의 타입이 비활성화될 경우 서버 `segment_closed` 응답에만 의존하면 사용자는 실패 요청 후에야 사유를 알 수 있음. 선택 타입이 disabled이면 시작 버튼을 비활성화하고 `시작 불가, 사유 ...` aria/title 및 상태 문구를 표시하도록 보강. 스모크 `startClosedSegmentUiGuard` 추가.
- **2026-06-12 루프 45**: W-08/W-09 결정 카드 상태 표시 점검 → 실제 브라우저에서 결정 대기함의 영역 label이 `pending_master 결정 9건`, 카드 상태가 `마스터 액션 대기 (pending_master)`로 노출되어 운영 화면에 내부 DB 토큰이 섞임. `마스터 액션 대기 결정 N건`, `C 마스터 확인`, `마스터 액션 대기`처럼 한국어 라벨을 기본 표시하고 원문 grade/status는 title/evidence에만 보존하도록 정리. 스모크 `decisionStatusRawTokenHidden` 추가.
- **2026-06-12 루프 46**: W-30 에이전트 질의 실패/재시도 흐름 점검 → 새 질의가 실패하면 이전 성공 응답이 응답 카드에 남아 에러와 오래된 답변이 동시에 보일 수 있음. 질의 시작 시 `setAnswer(null)`로 이전 응답을 지우고 busy/live region이 현재 요청 상태만 설명하도록 보강. 스모크 `askClearsStaleAnswerOnSubmit` 추가.
- **2026-06-12 루프 47**: W-41/W-43 인증·서버 실패 시 stale 데이터 점검 → 토큰 오류나 서버 오류가 발생해도 이전에 로드된 회의 목록/타임라인/결정 카드가 남으면 현재 권한·현재 서버 상태의 데이터로 오인할 수 있음. base fetch 실패 시 회의/실행/세그먼트/결정/상세/catchup 캐시를 비우고, 상세 fetch 실패 시 타임라인을 비워 `회의 상세를 불러오지 못했습니다.`만 남기도록 보강. 스모크 `authFailureClearsCachedData` 추가.
- **2026-06-12 루프 48**: W-30 에이전트 질의 입력 오류 상태 점검 → 한 번 실패한 질의의 오류 메시지가 에이전트 변경/질문 수정 중에도 계속 남으면 현재 입력에 대한 오류로 오인될 수 있음. 에이전트 선택 또는 질문 입력 변경 시 `setError('')`를 호출해 stale 오류를 제거하도록 보강. 스모크 `askInputClearsStaleError` 추가.
- **2026-06-12 루프 49**: W-04 회의 목록 탐색성 점검 → 회의 목록은 실제로 목록 탐색 영역이지만 카드 안의 버튼 묶음으로만 노출되어 보조기술이 전체 목록 크기와 항목 구조를 파악하기 약함. `회의 목록` region, `회의 목록 N건` live list, 항목별 listitem wrapper를 추가하고 버튼 자체의 선택/클릭 semantics는 유지. 스모크 `meetingListRegionA11y` 추가.
- **2026-06-12 루프 50**: W-04 실행 실패 표시 점검 → 서버는 failed run에 `error`를 저장하지만 웹 catchup은 상태/세션/완료 시각만 보여 실패 원인이 숨겨질 수 있음. failed run 표시에는 `오류: ...` 줄을 추가하고 원인이 비어 있으면 `원인 미상`으로 보이게 보강. 스모크 `failedRunShowsError` 추가.
- **2026-06-12 루프 51**: W-02 U1 캐치업 전달 품질 점검 → 실제 브라우저에서 캐치업 3줄은 시각적으로 분리되지만 live region의 접근성 텍스트는 줄 구분 없이 이어질 수 있음. 캐치업 영역에 `U1 캐치업 N줄 요약` list/listitem 구조와 `/` 구분 aria-label을 추가하고, 빈 catchup 배열도 기본 안내 문구를 표시하도록 보강. 스모크 `catchupLinesA11y` 추가.
- **2026-06-12 루프 52**: W-24 LLM 발언 용어 품질 재점검 → 실제 타임라인에 `입장한 거래` 표현이 남아 있어 이전 `진입` 용어 보정 범위가 부족함. 표시 정규화에 `입장한 거래 → 진입한 거래`를 추가해 DB 원문은 보존하고 웹/API 응답만 보정. 스모크 `legacyEntryTradeTermNormalized` 추가.
- **2026-06-12 루프 53**: W-24 LLM 게이트 해석 품질 점검 → 실제 해외 분석 minute에서 `halt 상태`를 `저평가 상태`로 설명해 배치 게이트를 가치판단으로 오해할 수 있음. 표시 정규화에 `저평가 상태 → 배치 halt 상태`를 추가해 원문은 보존하고 웹/API 표시만 보정. 스모크 `legacyHaltValuationTermNormalized` 추가.
- **남은 위험**: 실 DB write가 필요한 confirm/defer UI, 실 LLM 호출 품질, 텔레그램↔웹 동기, 정례 회의 반영은 운영 부작용 가능성이 있어 별도 승인/정례 사이클에서 검증.

## 운영 루틴 제안
- **매 회의 후(특히 첫 주)**: W-20·21·22·24·50 — 5분 체크. 헤드리스 캡처 보조: `Chrome --headless --screenshot=/tmp/mr.png --virtual-time-budget=10000 http://127.0.0.1:7791/`
- **주 1회**: D 섹션 전체 + W-10 교차 멱등.
- **자동화 후보(우선순위)**: ①W-21 JSON 부재(API 정규식 — 스모크 1케이스 추가) ②W-50(정례 후 세션 수 증가 단언) ③W-24(금지 패턴 정규식: 동일 문장 3연속).
