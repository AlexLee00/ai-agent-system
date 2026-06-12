# Hub LLM 정책 엔진 설계서 (HUB_LLM_POLICY_ENGINE_DESIGN) — R 시리즈

작성: 메티(Meti) / 2026-06-12
배경: 마스터 지시 "모든 팀 동일 오토라우팅 + 라이브러리/컴포넌트화로 단순화" (TRACKER §J 승인)
관계: H 시리즈(RELIABILITY, 완료) -> S 시리즈(STABILITY, S-1 종결) -> **R 시리즈(본 문서)**
통합 로드맵: STABILITY §5 (순번 5~6). 추적: TRACKER §R(신설 예정).

---

## 1. 문제 정의 (분산 정량 — 2026-06-12 실측)

| 증상 | 수치 |
|---|---|
| llm-model-selector.ts 단일 파일 | 2,211줄 |
| 정책이 흩어진 장소 | **5곳**: 프로필 테이블 2벌(LEGACY 623행/현행 1008행) + 함수 내 ROUTES 2개(SIGMA 1863/DARWIN 1891) + 후처리 함수 12개(순서 의존) + HUB_* env 7개 + 추상라우트 해석기(버전별 상이) |
| selectorVersion 분기 | 19곳 (v2_legacy / v3_oauth_4, A/B 퍼센트 env까지 존재) |
| 정책 표면 (실측) | **selectorKey 89개 x 12팀** (investment 23, hub 18, blog 13, claude 9, orchestrator 7, justin 6, ska 4, core 3, elsa 3, darwin/sigma/chronos 각 1) + agent 내부 차원(darwin/sigma.agent_policy 내 agent별 분기) |

비용 실증: 6/11 인시던트 대응 3커밋 = env 2개 신설 + 함수 개명 + 분기 추가. 정책 1개 변경이 코드 4곳을 건드림.

## 2. 현행 해석 파이프라인 (역공학 — 후처리 암묵 순서의 명문화)

applySelectorOptimizationPolicy(587행) 실제 순서:
1. backtest selector -> local-embedding 단독 (최우선 단락)
2. gemini 진단 키 예외 통과
3. gemini 엔트리 교체 -> 잔여 제거
4. darwin/sigma.agent_policy -> env 분기 -> ensureOpenAiPrimaryWithBoundedFallback (기본) | preferGroqWithOpenAiFallback
5. claude.* -> ensureOpenAiPrimary
6. CLAUDE_FIRST_WRITING 키 -> ensureClaudeWritingPrimary
7. applyGroqTokenPolicy + dedupe
8. 빈 체인 -> openai mini 최종 폴백
이후: applyLocalBacktestOnlyGuard(H2-c) -> applyProviderRuntimeGuards(claude-code/public-openai 교체) -> (실행층) 쿨다운 게이트(H1-a).

**함정 (스냅샷 필수 지식)**: describeLLMSelector 기본 해석은 LEGACY — 라이브는 OAUTH4.
실측: hub.alarm.interpreter.error가 default=claude-code/400(LEGACY) vs oauth4=groq/320(현행 라이브 값).
=> 모든 스냅샷/diff는 `{ selectorVersion: 'oauth4' }` 명시 고정.

## 3. 목표 아키텍처

### 3.1 선언 정책 스키마 (단일 소스)
```ts
type PolicyRule = {
  id: string;                      // 'darwin-default', 'hub-alarm-error' ...
  match: {                         // 구체도 높은 룰 우선 (specificity 정렬)
    team: string;                  // 'darwin' | '*'
    selectorKey?: string;          // glob: 'alarm.interpreter.*'
    agent?: string;                // 'darwin.edison' (ROUTES 내부 차원 흡수)
    taskType?: string;             // 'backtest_*'
  };
  chain: string[];                 // 추상 라우트: ['openai_mini', 'groq_scout']
  caps?: { maxTokens?: number; temperature?: number };
  flags?: { killSwitchEnv?: string };  // 룰 단위 비상 차단
};
```
- 1차 저장: TS const 단일 모듈 `packages/core/lib/llm-policy-table.ts` (코드 리뷰/배포 단순).
  2차(R4 이후 선택): DB 테이블 전환 — luna C17 Parameter Store 패턴 재사용.
- 팀별 차이는 룰 행으로: 신규 정책 = 1행 추가, 인시던트 대응 = 행 수정 (env 신설 금지).

### 3.2 단일 파이프라인 (전 팀 동일 코드 경로)
```
resolvePolicy(team, selectorKey, agent, taskType)   // 룰 매칭 (specificity 우선)
  -> buildChain(rule.chain)                          // 추상->구체: routeEntryFromAbstractRoute(oauth4 고정) 재사용
  -> applyGlobalGuards(chain, ctx)                   // §2의 3/7/8 + local-backtest + runtime-guards (순서 고정, 전역 4종만)
  -> applyBudget(chain, ctx)                         // token-budget 재사용, H3 접합점
  -> execute(unified-caller)                         // 비변경 (쿨다운 H1-a 그대로)
```
목표 효과: 엔진 ~300줄 + 정책 데이터. 후처리 12개 -> 전역 가드 4종. selectorVersion 분기 19 -> 0 (R4).

### 3.3 기존 자산 재사용 (재확인)
routeEntryFromAbstractRoute(해석기), token-budget, unified-caller, H6 게이트(GATE-R 추가),
listLLMSelectorKeys + describeLLMSelector(스냅샷), LLM_TEAM_SELECTOR_AB_PERCENT(점진 롤아웃 메커니즘 — R3 재사용 검토).

## 4. 전수 스냅샷 명세 (R1 산출물 — CODEX-R1 범위)

목적: R2 shadow 비교의 **기준선**. 신 엔진이 같은 입력에 같은 체인을 내는지 diff=0 검증의 좌변.
- 도구: 기존 listLLMSelectorKeys() x describeLLMSelector(key, { selectorVersion: 'oauth4' }) — 신규 해석 로직 작성 금지.
- 매트릭스: 89키 전수 x 변형 차원:
  (a) 기본 호출  (b) taskType='backtest_judgment' / 'backtest_embedding'  (c) darwin/sigma.agent_policy는
  ROUTES 내부 agent 키 전수(소스에서 추출)  (d) env는 전부 기본값 상태(킬스위치 미설정)로 1회 + 문서화.
- 출력: `docs/hub/snapshots/llm-chain-snapshot-<date>.json` — { key, variant, chain:[{provider,model,maxTokens}] } 정렬·결정적.
- 재실행 가능(멱등) + `--diff <old.json>` 모드(변화 감지).

## 5. GATE-R (H6 게이트에 1종 추가)
- contract: 정책 테이블 모듈 존재 + 엔진 스모크 통과 + 스냅샷 파일 존재.
- evidence: shadow 비교 로그(신구 체인 diff) 최근 N일 — **diff=0 비율 100%** (불일치 1건이라도 있으면 pending).
- 상태: blocked -> contract_only -> shadow_ready_data_pending -> ready_for_master_review. --apply 영구 차단 (H6 동일).

## 6. 전환 단계 (빅뱅 금지)
| Phase | 내용 | 킬스위치/판정 |
|---|---|---|
| R1 (본 설계) | 설계서 + CODEX-R1(스냅샷 스크립트) | 마스터 승인 |
| R2 | 엔진 + 정책 테이블(현행 충실 복제) + shadow 비교 모드 | `HUB_LLM_POLICY_ENGINE_MODE=off|shadow` 기본 off -> shadow. GATE-R |
| R3 | 팀 단위 활성: darwin/sigma -> hub -> blog -> claude -> investment 외 | MODE=team:<csv> (또는 AB_PERCENT 재사용). 팀별 GATE-R evidence |
| R4 | 레거시 소거: 테이블 2벌->정책 테이블 1, version 분기 19->0, 후처리 12->가드 4, env 7->2~3 | 회귀 스모크 + 스냅샷 diff=0 재확인 |

R2의 정책 테이블은 **스냅샷에서 기계 생성**(snapshot-to-policy 변환)을 1차로 하고 수동 보정 — 전사 오류 방지.

## 7. 테스트 시나리오 (정식 원천 — R 시리즈)
| ID | Given/When/Then |
|---|---|
| TS-R1-1 | 스냅샷 스크립트 실행 -> 89키 전수 + 변형 차원 포함, 결정적(2회 실행 diff 없음) |
| TS-R1-2 | oauth4 고정 검증 — hub.alarm.interpreter.error가 groq primary(현행)로 기록 (LEGACY 값이면 FAIL) |
| TS-R1-3 | --diff 모드: 스냅샷 간 변화 감지 동작 |
| TS-R2-1 | shadow 모드에서 전 표면 diff=0 (불일치 목록 0) |
| TS-R2-2 | MODE=off -> 신 엔진 코드 경로 미사용 (현행 무영향) |
| TS-R2-3 | 전역 가드 순서: gemini 제거 -> local-backtest -> runtime-guards -> budget 순 보존 (스모크 단언) |
| TS-R3-1 | MODE=team:darwin -> darwin만 신 엔진, 타 팀 구 경로 (로그 태깅으로 구분) |
| TS-R4-1 | 레거시 소거 후 전 스모크 + 스냅샷 diff=0 유지 |

## 8. CODEX-R1 범위 (다음 코덱스 작업 — 스냅샷만, 엔진은 R2)
- 신규: `bots/hub/scripts/llm-chain-snapshot.ts` (§4 명세) + `smoke:llm-chain-snapshot`(TS-R1-1~3) + package.json.
- 비접촉: llm-model-selector.ts 등 기존 전부 (read-only 사용만).
- 자기보고: TS-R1 결과표 + 스냅샷 파일 통계(키/변형 수) + oauth4 고정 증빙.

## 9. 마스터 결정 포인트
1. 본 설계 승인 -> CODEX-R1 프롬프트 작성(메티)
2. R2 정책 테이블 1차 저장소: TS const 모듈(권고) vs DB 테이블 — 권고안 승인 여부
3. R3 롤아웃 레버: MODE=team:<csv>(권고, 명시적) vs AB_PERCENT(기존 메커니즘) 선택
