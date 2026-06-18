# 루나팀 성장 보강 검토 — 에이전트·매매 (기술적·기법적·로직적)

> 작성: 메티(Meti) · 날짜: 2026-06-08 · 상태: 검토·보강안(코드 대조 전)
> 입력: ① 루나 소스코드 ② 자기개선(SELF_IMPROVEMENT_RSI_BOOST/APPLY_REVIEW, SI-01~08) ③ 외부 서칭(트레이딩 에이전트 성장 최신 — arXiv 2509.11420·2508.06312·2508.02366·2402.03755·2506.04651·2603.16365·2601.19504)
> 방침(마스터): 자기개선 **루나 먼저 → 이후 확장**. 루나 에이전트·매매가 **기술적·기법적·로직적**으로 성장.
> 안전: 모든 성장은 SI 안전레일(검증게이트·24h 자동롤백·kill-switch·단일변수·증거번들) 안에서만.

---
## 1. 성장 프레임 — 2 도메인 × 3 축
| | **기술적**(데이터·피처·인프라) | **기법적**(방법·모델) | **로직적**(전략·규칙) |
|---|---|---|---|
| **에이전트 성장** | 메모리/RAG·관측성 | 다중에이전트 토론·추론 | 프롬프트·스킬 자가진화 |
| **매매 성장** | 알파팩터·피처 생성 | LLM-guided RL·앙상블 | 전략 발견·레짐 로직 |

---
## 2. 루나 기존 성장 표면 (소스 실측)
- **에이전트**: ESPL 프롬프트 진화(darwin espl.ex, shadow 세대) · `skills/luna/*.skill.md` 7개 + `posttrade-skill-extractor` · 3층 reflexion(l1/l2/l3, checkAvoidPatterns) · agent-memory-4layer · A2A `multi-agent-coordination`/`multi-agent-trade-decision`.
- **매매**: RL PPO(`train-luna-ppo`·`luna_trading_env` 위험조정 보상) · finrl-x 4층(전략 진화) · `regime-weight-learner`(가중치 학습) · `hmm-regime-detector` · `discovery/`(orchestrator·universe·news-to-symbol) · `signal.ts`(지표) · `candidate-backtest-gate`(DSR/PBO/walk-forward).
→ **강함**. 빈 곳 = **알파팩터 생성(로직 발견)** · 메모리 감쇠 · LLM-guided RL 정식화 · 토론 정식화.

---
## 3. 외부 서칭 종합 (최신 기법 → 축 매핑)
- **알파팩터 생성**(로직·기술): GP/DSO · **RL=AlphaGen** · **LLM=Chain-of-Alpha**(Factor Generation+Optimization 이중체인, 백테스트 피드백) · Alpha-GPT(인간-AI·외부메모리) · **FactorEngine**(팩터=실행가능·감사가능 Turing 코드·레짐강건). 평가=**IC/RankIC/RankIR**.
- **LLM-guided RL 하이브리드**(기법): LLM 고수준 전략→RL 전술 실행 → SR↑·MDD↓(RL 단독 대비). 단 reward shaping 필요·MoE 모듈화.
- **다중에이전트 토론**(기법): 전문화 에이전트(불/베어/리스크) 토론 → 강건성·사실성↑(TradingGPT/FinAgent).
- **계층 메모리+RAG+감쇠**(기술·에이전트): FinMem — 최근뉴스+리포트+장기, 벡터DB, **인간형 감쇠 랭킹**.
- **추론+RL**(Trading-R1) · **자가진화 프롬프트·코드**(Agents of Change "스스로의 설계자") · **자기개선+지식베이스+피드백**(QuantAgent, 지식베이스 품질 의존 주의).
- **레짐적응 앙상블**(2601.19504): 추세(EMA/MACD)+평균회귀(RSI/BB)+감정(FinBERT)+ML(XGBoost)+레짐필터(변동성/수익환경).

---
## 4. 성장 보강안 (LG-01 ~ LG-07)

### 기술적
- **LG-01. 알파팩터 생성 루프 [신규·핵심]**: 후보 팩터 생성(LLM Chain-of-Alpha식 이중체인 또는 RL AlphaGen식) → **IC/RankIC 평가** → `candidate-backtest-gate`(DSR/PBO) 검증 → 통과분 `signal`/`skill` 승격. 팩터=**실행가능·감사가능 코드**(FactorEngine). 안전: shadow→마스터 게이팅. 자산: `discovery` + `candidate-backtest-gate` + `skills/luna`. **로직·기술 성장의 핵심 빈 곳.**
- **LG-02. 메모리 감쇠·경험 RAG [확장]**: agent-memory-4layer에 **감쇠 랭킹**(FinMem식) + 거래 경험 RAG 회수(유사 국면 과거 결정/결과). 자산: 4layer + pgvector.

### 기법적
- **LG-03. LLM-guided RL 하이브리드 [정식화]**: LLM 고수준 전략/레짐 판단 → RL(`train-luna-ppo`) 전술 실행. reward=**SI-01 검증가능**. SR↑MDD↓ 기대. 자산: 분석 노드 + RL 파이프.
- **LG-04. 다중에이전트 토론 [정식화]**: 회의실 C5 토론 = 전문화 에이전트(불/베어/리스크/펀더멘털) 토론 → 합의·반론. 자산: A2A `multi-agent-coordination`/`multi-agent-trade-decision` + 회의실.

### 로직적
- **LG-05. 전략 발견(변이 넘어 생성) [신규]**: finrl-x는 부진 전략 **변이**, 신규=**LLM 전략 가설 생성**(시장 관찰→가설→검증→승격). SI-04 그룹상대 비교로 선택. 자산: `discovery` + finrl-x + SI-04.
- **LG-06. 프롬프트·스킬 자가진화 안전 루프 [확장]**: ESPL 프롬프트 진화 + skill-extractor → **SI-02 증거번들 + SI-03 24h 롤백** 경유. "스스로의 설계자"를 안전하게. 자산: ESPL + skills + SI-02/03.
- **LG-07. 레짐 적응 앙상블 로직 [확장]**: 추세(EMA/MACD)+평균회귀(RSI/BB)+감정+ML(XGBoost)을 **레짐 필터로 동적 가중**. 자산: `signal.ts` + `regime-weight-learner` + `hmm-regime-detector`(B-10).

---
## 5. 성장 ↔ 자기개선 결합 (어떻게 **안전하게** 성장하나)
성장 산출물(팩터·전략·프롬프트·스킬)은 **모두 SI 파이프라인 통과**:
```
생성 → shadow → 검증게이트(SI-05: DSR/PBO/OOS/캘리브레이션) → 증거번들(SI-02) → 24h 자동롤백+kill-switch(SI-03) → 통과분만 승격
```
- 보상=검증가능(SI-01) · 그룹상대 선택(SI-04) · 오류회피 RAG(SI-08) · **방향·중단=마스터**(SI-07).
→ Anthropic: 성장 속도 = 도구·실험수의 함수 / 안전 = **브레이크 페달**. 둘을 동시에.

---
## 6. 우선순위
1. **LG-01 알파팩터 생성**(로직 성장 핵심·신규) — 단, **SI-05 검증게이트 위에** 세움(검증 없는 팩터 승격 금지).
2. **LG-05 전략 발견** + **LG-03 LLM-guided RL**(매매 성장).
3. LG-07 레짐 앙상블 · LG-04 토론 · LG-02 메모리 · LG-06 자가진화(에이전트 성장).
→ 전부 **SI 안전레일(SI-03/02/01) 선행·동반**. 안전 없는 성장 가속 금지.

---
## 7. 다음 단계
- LG-01~07 **코드 대조 정밀 검토**(각 기존자산 file:line — discovery·candidate-backtest-gate·signal·train-luna-ppo) → 적용안(advisory vs 경계·무중단·테스트) → CODEX.
- **순서 조율**(대기 3건): SI(자기개선 안전레일) · 루나 회의실 Phase 1 · 본 성장(LG). 권장 순서 = **SI-03/02/01(안전) → LG-01(알파팩터) → 회의실** 또는 마스터 지정.
