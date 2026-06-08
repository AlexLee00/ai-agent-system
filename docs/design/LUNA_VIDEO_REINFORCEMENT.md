# 루나팀 보강 — 트레이딩 영상 분석 (메티)

> 작성: 메티 · 2026-06-08 · 상태: 진행 중 (배치 1/3 완료)
> 목적: 마스터 지정 13개 영상 분석 → 루나팀(meeting-room v0.2) 보강안 도출. 자막 캐시 `/tmp/ytdistill/clean/`.
> 배치: ① Claude 금융·팀·자기학습(완료) ② 퀀트 구현(클로드코드퀀트·24시간·완전자동화) ③ 전략·매매기법(알고제왕·주식시장·단타·매매분석법)

## 배치 1 — 분석한 영상 (6)
1. grill-me/grill-with-docs (XCknkMrgu9A, ko)
2. Claude 금융 플러그인 (8IQ8PttfmDU, en)
3. 파이낸스 에이전트 10종 (XewJA0aXm4Q, en)
4. 파이낸스 대시보드/agent-view (4vZZReXFKkQ, en)
5. 클로드 트레이딩 팀/paperclip (cXhEw2jF4go, en)
6. 스스로 학습 에이전트/Hermes (6njREUQAFdg, en)

## 보강안 (B-01 ~ B-09)

### B-01. ADR 결정 기록 — 회의 의사결정 [강력 권장]
- 출처: grill-with-docs (mattpocock/skills, 외부 확인).
- 회의 결정을 **ADR(Architecture Decision Record)** 양식으로: 결정 + 맥락 + 대안 + 근거 + 되돌림 조건.
- **ADR은 3기준 모두 충족 시에만 생성**(과한 기록 방지): ① 되돌리기 어려움 ② 맥락 없으면 "왜 이렇게?" ③ 실제 트레이드오프(대안 존재). → 매매 결정·전략 채택·리스크 정책 변경에 적용.
- v0.2 매핑: §5 회의록 + thesis-tracker 강화. 진입/청산 = "왜 샀나/팔았나 + 무엇이 바뀌면 뒤집나".

### B-02. CONTEXT.md — 루나 유비쿼터스 용어집 [권장]
- 출처: grill-with-docs.
- 도메인 용어(후보·포지션·리스크밴드·레짐·신뢰도·universe…)를 **글로사리(구현 세부 배제)**로 고정 → 전 에이전트 언어 정합, 모호/과적 용어 제거. `bots/investment/CONTEXT.md`.

### B-03. grill 패턴 — 큰 결정 전 자기심문 [권장]
- 출처: grill-me (한 번에 한 질문 + 항상 추천, 16~50문, 결정트리 가지치기; 코드/RAG로 답되면 탐색).
- 큰 매매/전략 결정 전 루나가 **가차없는 자기심문**으로 가정 노출 → ic-memo "what makes this wrong"(G5) 강화. 회의 안건 ⑥ 전 advisory 게이트.

### B-04. 좋은 트레이딩 에이전트 4기준 [프레임워크]
- 출처: 스스로학습(Hermes 영상).
- ① 정확한 데이터(시점정합·소스신뢰·다중모델 객관화) ② 24/7 신뢰성 ③ **명확한 목표(성공/실패 정의 + 매 거래 점수화)** ④ **자기개선(가설→결과→새 가설)**.
- v0.2 매핑: ①=point-in-time+G2/G3+이종모델 ②=OPS launchd PROTECTED ③=B-05 ④=B-06.

### B-05. 명시적 성공/실패 스코어러 [권장]
- 출처: 스스로학습. "vibes 아니라 numbers" — 목표(목표 Sharpe/DSR·max DD·기간수익)를 파일로 정의, **매 결정/거래를 목표 대비 점수화**(목표 방향=good / 역방향=bad).
- v0.2 매핑: §11 검증·계측에 **per-decision scorer** 추가 → CVRF 입력, CPCV 리더보드 연결.

### B-06. 과학적 방법 자기개선 — 한 번에 한 변수 [강력 권장]
- 출처: 스스로학습.
- 전략 진화 = **한 번에 한 변수만 변경** → 테스트 → 더 나으면 **새 베이스라인** → 그 위 반복. (다변수 동시 변경 시 인과 불명.)
- v0.2 매핑: CVRF + 다윈/시그마 전략진화 + CPCV 리더보드에 **단일변수 A/B + 베이스라인 승격** 규율. 실험은 막지 않되 인과 보존.

### B-07. CEO/이사회 단일 창구 위임 [확인·강화]
- 출처: 클로드 트레이딩 팀(paperclip). 인간=이사회, **CEO(=Luna) 한 명과만 대화** → 부서 위임, 결과 인박스 보고.
- v0.2 매핑: Luna=의장 대리(오케스트레이터) 단일 창구 강화. 화면②(@직접질의)는 보조, 기본은 Luna.

### B-08. 비용 최적화 에이전트/가드 [권장]
- 출처: paperclip(6-에이전트에 **cost-optimizer** 포함; 동시 실행으로 1분 $40 경험).
- 클라우드 이종 토론 비용: local=백테스트, cloud=결정만, 동시성 캡, 배치. `cost-tracker`를 **cost-optimizer 역할**로 승격.
- v0.2 매핑: §15 cost-tracker + advisory 가드 "비용 상한/동시성".

### B-09. agent-view 병렬 위임 뷰 [UI 권장]
- 출처: 파이낸스 대시보드(Claude Code 네이티브 agent-view) — 다수 에이전트 병렬 작업 한 화면 + 완료/진행/**needs-input 큐**.
- v0.2 매핑: 회의실 §8 화면①을 **에이전트별 병렬 작업·상태 패널 + needs-master-input 큐**로 확장. :7787 연동.

### 전략 원칙 (영상 공통)
- **분석 안목은 스케일된다(좋든 나쁘든)** → 검증(forward/CPCV)이 스케일 전 관문. (파이낸스 에이전트)
- **소수 종목 깊게 > 다수 얕게** → 제약형 universe + thesis 장기추적 강화. (파이낸스 에이전트)
- **paper 기본 · 실거래는 명시 전환**(read-only→approve→live) → v0.2 결정①(paper 원장)과 정합. (paperclip·Hermes 공통)

## 외부 확보 자료
- **mattpocock/skills** (github): `grill-me`(productivity)·`grill-with-docs`(engineering)·triage·improve-codebase-architecture·tdd·handoff·to-prd. 설치 `npx skills add` 또는 SKILL.md 수동 복사. ADR 3기준 = 되돌리기 어려움 + 맥락없이 의아 + 실제 트레이드오프. CONTEXT.md = 글로사리(구현 배제, DDD bounded context). 스킬들이 루프 구성(grill→to-prd→…→improve-codebase-architecture).

## 평가 대기 도구 (배치 2에서 딥서칭)
- **paperclip** (MIT, ~50k★ 에이전트 오케스트레이션 호스트) — 자체 오케스트레이터 보유 → 패턴만 차용.
- **Hermes agent** (자기학습 자율 에이전트, "open Claude보다 낫다" 주장) — CVRF/자기개선 레이어 대안으로 검증. (※ 우리 헤르메스 에이전트와는 무관한 동명).
- **agent-view** (Claude Code 네이티브 병렬 뷰) — UI 차용 검토.
- **Railway** (Hermes 영상의 24/7 호스팅) — 우리는 OPS launchd로 대체(차용 불필요).

## 다음 세션
- **배치 2**: 클로드코드퀀트(ZVMTeDBmSrI)·24시간 트레이더(6MC1XqZSltw)·완전자동화 봇(y_bsjZThP0o) → paperclip/Hermes/TradingView MCP 딥서칭 포함.
- **배치 3**: 알고 트레이딩 제왕(1SLbe0k6x4I)·주식시장(lH5wrfNwL3k)·단타기술(3L4LhT5lAWg)·거래매매분석법(QaJnyy3-8Wg) → 매매기법은 전략/지표로 정제.
- 이후: 보강안(B-01~)을 **DESIGN/TRACKER v0.3로 통합**.


---

## ⚠️ 세션 상태 / 복구 필요 (2026-06-08)
- **v0.2 작업이 git 리셋으로 유실됨**: DESIGN/TRACKER/HANDOFF가 마지막 커밋(`24383e19f` "auto 09:31", v0.1)으로 되돌아감. 미커밋(+미푸시) 변경이 `git reset --hard`/`checkout`(deploy.sh/sync 추정)에 폐기. **이 문서(미추적)만 생존.**
- **유실 내용**(이 대화에 보존 → 재생성 가능):
  1. DESIGN v0.2(211줄): 가드 슬림(계측/경계 최소 3)·마스터 다이얼+earned 텔레메트리·CPCV 리더보드·temporal-validity+CVRF·듀얼 의사결정·적응 토론·6 Lane 매핑·§16 소스 검증 실측 계약.
  2. 회의 시작 버튼 + 루나 폴백(일일 05–06창/폴백 06:00, 주간 일요일 06–07창/폴백 07:00) + 휴장일 버튼 비활성·팝업.
  3. 3대 결정: ① paper 주문=별도 원장(DB), LIVE 시만 l31 ② Hub=독립 loopback+hub-proxy ③ 이종=불(zeus)=Claude/베어(athena)=OpenAI(zeus.yaml llm_routing 변경).
  4. TRACKER v0.2(111줄): WS-A~H(+일정/정례화 WS-G), 재사용 API 정정.
- **소스 검증 실측 계약(재확인 완료, 유효)**: 노드=`{id,type,label,run}`·ID 대문자·`node.run({sessionId,market,symbol})` · L20 노드 없음 · 이종은 `resolveAgentLLMRoute`+agent yaml(현재 zeus·athena 둘 다 gpt-5.4-mini) · `isKisHoliday`(DB)/`evaluateKisMarketHours`(폴백) · `KR_HOLIDAYS_2026` 비-export · execution-risk-and-capital facade(`buildExecutionRiskApprovalGuard`·`preTradeCheck`·`checkCircuitBreaker`·`calculatePositionSize`) · luna.ts(`getSymbolDecision`·`getDebateLimit`·`orchestrate`) · Hub=route-registry/server.ts/hub-proxy · migration `YYYYMMDDHHMMSS_…`.
- **근본 원인**: 작업이 커밋(필요시 푸시)되지 않으면 deploy/리셋마다 유실.

### 다음 세션 순서 (고정)
1. **지속성 확보 먼저**: 마스터가 커밋/푸시하거나 deploy.sh의 `reset --hard`/`checkout` 동작 점검(작업 보존되도록). 이 REINFORCEMENT 문서도 미추적 → `git add` 권장.
2. **v0.2 재생성**: 위 유실 내용 1~4 + 검증계약을 DESIGN/TRACKER/HANDOFF에 복원 → **즉시 커밋**.
3. **영상 배치 2**: 클로드코드퀀트(ZVMTeDBmSrI)·24시간(6MC1XqZSltw)·완전자동화(y_bsjZThP0o) + paperclip/Hermes/TradingView MCP 딥서칭. **배치 3**: 알고제왕(1SLbe0k6x4I)·주식시장(lH5wrfNwL3k)·단타(3L4LhT5lAWg)·매매분석(QaJnyy3-8Wg).
4. **통합**: 모든 배치 분석 후 보강안(B-01~) + v0.2를 **v0.3로 한번에 통합** → 커밋. 이후 Phase 1 CODEX 프롬프트.
- 자막 캐시: `/tmp/ytdistill/clean/`(13개, ephemeral). 유실 시 `/tmp/yt-dlp`로 재취득(바이너리도 /tmp).
