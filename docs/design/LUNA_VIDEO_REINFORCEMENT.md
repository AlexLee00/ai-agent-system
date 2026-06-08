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


---

## 배치 2 — 분석 완료 (3편) · ※ 위 복구 메모는 해결됨(v0.2 복원·커밋 1ac91958d 완료)
분석: 클로드코드퀀트(ZVMTeDBmSrI)·24시간 트레이더(6MC1XqZSltw)·완전자동화 봇(y_bsjZThP0o)

### B-10. Markov 레짐 전이행렬 모델 [강력 권장]
- 출처: 클로드코드퀀트·완전자동화(Rowan "hedge fund method").
- 상태(bull/sideways/bear = 20일 누적수익 ±5%) → 전체 이력 라벨링 → **전이행렬 3×3**(행=오늘·열=내일·행합 100%) + stickiness(대각=지속성). 행렬 제곱=다일 예측 · 정상분포=장기 신호소멸.
- v0.2 매핑: Research/Decision 레인의 **레짐 신호**. C3 temporal-validity(Markov=시점정합)·CONTEXT.md '레짐'(B-02)와 정합.

### B-11. 신호 = P(bull)−P(bear), 차등 사이징 [권장]
- 출처: 클로드코드퀀트. 신호 = 내일 bull확률 − bear확률. 양수=롱/음수=숏, **차이 크기 = 포지션 크기**(conviction-weighted).
- v0.2 매핑: `computeDynamicPositionSizing`(§16)에 레짐 conviction 신호 입력.

### B-12. 레짐 모델 정밀화 [강력 권장]
- 출처: 완전자동화(HMM).
- **레짐 개수 자동선택**(3~7 테스트→best, 하드코딩 금지) · **forward-algorithm-only**(full predict=룩어헤드 유발 → 누수 차단) · **regime stability filter**(≥3 bar 지속해야 행동, 플리커→사이즈↓+경고).
- v0.2 매핑: point-in-time 가드(계측 진실성) 강화 · CPCV(C2) 결합 · **HMM 비지도 레짐 + B-10 규칙기반 라벨 일치 시만 진입**(거짓신호↓, fuseSignals/토론 확인 정합).

### B-13. 리스크 회로차단기 = 하드코딩·모델독립 veto [강력 권장]
- 출처: 완전자동화. "평범전략+훌륭한 리스크관리=소액손실 / 훌륭전략+나쁜 리스크관리=계좌파탄."
- **AI와 독립된 하드코딩 회로차단기**(veto): 일 −2%→사이즈 반감 · −3%→전량청산 · 주 −5%→반감 · **peak −10%→전 시스템 중단 + block 파일 → 마스터 수동 삭제로만 재개** · **correlation 체크**(기존 포지션과 상관 높으면 진입 금지).
- v0.2 매핑: **가드 철학의 "경계(되돌릴 수 없는 손실)" → 실험판에서도 유지**. `checkCircuitBreaker`(§16)에 구체 임계값. drawdown→마스터 리셋="실거래=마스터 행동" 정합 · correlation=Nemesis 과집중/ic-memo.

### B-14. 모델 강점 = 펀더멘털/스윙(데이 트레이딩 아님) [전략 원칙]
- 출처: 24시간. Opus agentic financial analysis = 필링 소화·논지 작성에 강함 → 펀더멘털/스윙. 기술적 데이 트레이딩 아님.
- v0.2 매핑: 루나 morning-note/ic-memo(OpenDART 필링) 검증. **모델 강점에 전략을 맞춘다.**

### B-15. 컨텍스트 예산 규율 [권장]
- 출처: 24시간. 토큰=돈, 회의/라우틴당 예산(~200k), context rot(1M 다 안 씀). 시스템지시+전략+거래로그+리서치 모두 소비.
- v0.2 매핑: 회의 오케스트레이터 **선택적 RAG 회수**(전체 덤프 금지)+세션 예산 관리. B-08 보강.

### B-16. 검증 보강 — 벤치마크·스트레스·캘리브레이션 [권장]
- 출처: 완전자동화. CPCV 리더보드에 **벤치마크**(buy-and-hold·200일 SMA 추세·random-entry 동일리스크) + **크래시 스트레스 주입**(10~15% 단일일 급락) + **regime/confidence 버킷**(고신뢰가 저신뢰보다 우수한지=캘리브레이션).
- v0.2 매핑: §12 백테스트(C2)·F2 리더보드에 추가.

### B-17. self-evolving 절차 스킬 [권장]
- 출처: Hermes(자기개선 루프). 반복 성공 패턴 → **재사용 스킬 문서 자동 생성**(절차적 메모리). "같은 걸 반복 요청 → 스킬화."
- v0.2 매핑: CVRF(신념·선언적) + **절차적 메모리(스킬)** 보완. 다윈 R&D 정합. agentskills.io 표준 참고.

### 빌드·운영 검증 (영상 ↔ 우리 설계 일치 확인)
- scaffold 먼저(로직 0)→컴포넌트별→**매 단계 테스트**(완전자동화 134 tests) = 우리 WS/3역할/메티 독립검증.
- stateless-wake→read files→act→**write-back**(24시간) = C3 메모리·CVRF.
- paper 우선→≥1달 모니터→live = 결정① paper 원장. 24/7 = 그들=remote/cloud(push-back) / 우리=OPS launchd(push-back 유실=이번 git reset 이슈).

## 도구 딥서칭 결과 (배치 2)
- **TradingView MCP** (다수·2026초): ①데이터형(bidouilles·호스티드: OHLCV·지표·뉴스) ②CDP 데스크톱 제어형(tradesdontlie·LewisWJackson·78 tools·Pine Script). ⚠️ 제어형=**ToS 충돌·코드주입·로컬 CDP 보안위험**. → 루나(KIS·OpenDART 보유·펀더멘털)엔 **데이터형만 선택적 보조**, 제어형 비채택. Pine Script Markov 시각화는 nice-to-have.
- **paperclip** (@dotta·MIT·~53k★): 에이전트=회사 오케스트레이션, **빌드 안 함**(기존 에이전트 래핑). → 자체 보유=비채택, **패턴 차용**: atomic checkout+예산 100% 자동정지(B-08)·heartbeat 상태지속(C3)·goal ancestry(B-01)·governance+rollback(git/ADR)·시크릿 스크러빙.
- **Hermes agent** (Nous Research·MIT·2026.02): 자기개선 학습루프 하니스(self-evolving 스킬·curated 메모리+nudge·FTS5·Honcho·RL/Atropos). → OpenClaw+Claude Code 보유=하니스 교체 비채택, **자기진화 절차-스킬 패턴 차용**(B-17). (우리 헤르메스 에이전트와 무관한 동명.)

## 다음 세션 — 배치 3 (마지막)
- 알고 트레이딩 제왕(1SLbe0k6x4I)·주식시장(lH5wrfNwL3k)·단타기술(3L4LhT5lAWg)·거래매매분석법(QaJnyy3-8Wg) → 매매기법은 전략/지표로 정제.
- 이후: 전 배치 보강안(B-01~B-17+) + v0.2 → **DESIGN/TRACKER v0.3 한번에 통합** → 커밋 → Phase 1 CODEX 프롬프트.


---

## 배치 3 — 분석 완료 (4편, 매매기법) · 전 영상(13편) 분석 종료
분석: 알고제왕(1SLbe0k6x4I)·주식시장(lH5wrfNwL3k)·단타(3L4LhT5lAWg)·매매분석법(QaJnyy3-8Wg)

### B-18. 검증 3종 게이트 — RST·Monte Carlo·멀티기간 OOS [강력 권장]
- 출처: 알고제왕(Jesse+Opus).
- **RST(규칙 유의성 테스트)**: 엔트리 규칙이 N개(예 2000) 랜덤 변형을 이기는지(P<임계) → 엣지 확인 후에만 exit/사이징 작성.
- **Monte Carlo**: ① 거래순서 셔플(사이징 견고성·worst 5% DD) ② 합성캔들 스트레스(과적/견고성). 원본 백테스트가 시뮬 중앙 부근=양호.
- **멀티기간/레짐 OOS**: 여러 해(상승/하락/횡보) 검증. (예시 전략: 2024+·2023+·2025 붕괴 → 미운영 판정.)
- "**엣지 ≠ 수익**"(208거래 수수료로 손실) → 검증은 **순(net: 수수료·슬리피지 후)** + 거래빈도 패널티.
- v0.2 매핑: §12 백테스트(C2)·F1/F2에 RST·MC·OOS 추가 → CPCV/DSR/PBO와 다층 검증.

### B-19. 스마트머니/수급 흐름 추적 = Research 신호 [권장]
- 출처: 주식시장(copy-trading·Capitol Trades). 기관·내부자·정치인 흐름이 시장에 앞섬.
- v0.2 매핑: **KR = DART 5%대량보유·임원·외국인 수급·행동주의 공시**(리서치 갭 후보) → Research 레인(Argos) 신호 강화. B-14 펀더멘털 정합. 해외 확장 시 13F·Capitol Trades류.

### B-20. 트레일링 스톱(래칫) + 래더 엔트리 [권장]
- 출처: 주식시장. 트레일링 스톱=플로어 상승만(이익 잠금) · 래더=하락 시 분할 매수(평단 개선).
- v0.2 매핑: Policy(Nemesis)·Execution 출구/진입 관리 · 회로차단기(B-13)·재진입과 결합.

### 전략 템플릿 (선택·스윙 호환)
- 추세추종: Donchian 돌파 + EMA 추세필터 + ATR 스톱(×2) + 리스크% 사이징(Jesse risk_to_qty 형). 루나 스윙 전략 라이브러리 후보. (Jesse=참고 백테스트 프레임워크.)

### 비채택 / 범위 밖 (정직한 판정)
- **옵션 휠 전략**(주식시장 Lv3): 계기 복잡(배정·그릭스·마진) + 풋 매도=의무("경계" 리스크). 현 범위(주식·crypto·펀더멘털) 밖 → 향후 옵션 확장 시 재검토.
- **스캘핑 매직 지표**(단타 "Predator 2.0", 승률 99.97% 주장): 마케팅 레드플래그 + B-14(펀더멘털/스윙) 상충 + DSR/PBO/CPCV로 과적 판정 류 → 비채택.
- **"드러켄밀러 가격선" 지표**(매매분석법): 허위 귀속(실제 드러켄밀러와 무관) + 마케팅 → 지표 비채택. 단 **거래량 확인(volume-at-price: 물량소화·유동성흡수·매도벽)** 일반 개념은 **선택적 진입 타이밍 보조**(레짐 B-10/B-12 보조), 코어 아님.

## 전 영상 분석 종료 (13/13) — 다음 단계
- 보강안 **B-01 ~ B-20** + 비채택 판정 완료.
- **다음 세션: 전 보강안 + v0.2 → DESIGN/TRACKER v0.3로 한번에 통합** → 커밋 → Phase 1 CODEX 프롬프트.
- 통합 우선순위: **강력권장**(B-01 ADR·B-06 단일변수·B-10 레짐·B-12 레짐정밀·B-13 회로차단기·B-18 검증3종) → **권장**(B-02·B-03·B-05·B-07·B-08·B-09·B-11·B-15·B-16·B-17·B-19·B-20) → **참고/선택**(B-04 프레임워크·B-14 원칙·전략 템플릿·도구 패턴).
