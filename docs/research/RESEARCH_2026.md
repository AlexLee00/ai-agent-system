# 📊 최신 리서치 (2026-02-27)

> 커뮤니티 + 논문 + 벤치마크 기반 조사 결과
> 내일 작업 (LLM 모델 문서 학습 + 매출 예측 엔진 설계)에 활용

---

## 1. LLM 모델 순위 (2026년 2월 기준)

### 전체 순위 (LM Council + Onyx 벤치마크)

| 순위 | 모델 | 강점 | 비고 |
|------|------|------|------|
| 1 | **Gemini 3** | 추론, 멀티모달 | LMArena 1501 Elo — 첫 1500 돌파 |
| 2 | **GPT-5.1** | 범용, 균형 | Instant + Thinking 모드 |
| 3 | **Claude Opus 4.6** | 코딩, 에이전트 워크플로우 | SWE-bench 1위, Elo 1510 |
| 4 | **Claude Sonnet 4.6** | 자율 에이전트, 멀티파일 추론 | 프로덕션 에이전트 최적 |
| 5 | **Grok 4.1** | 실시간 정보, 감성 분석 | X 통합 → 실시간 뉴스 강점 |
| 6 | **DeepSeek V3/R1** | 비용 효율 추론 | 최고 모델 대비 1/5 비용 |

### 툴 사용 / 함수 호출 순위 (BFCL V4)

- **1위**: GPT-4 계열 — Tool F1 Score 0.974
- **2위**: o3-2025 — 에이전트 시나리오 최고 성능
- **3위**: Claude Sonnet 4.5 — 라우팅 기반 멀티툴
- **오픈소스 강자**: Qwen3-Coder-30B, GLM-4.5-Air

### 속도 vs 비용 (프로덕션 에이전트용)

| 모델 | 속도 | 비용 (1M 토큰) | 용도 |
|------|------|----------------|------|
| Groq LLaMA-3.1-8B | ~200ms | 거의 무료 | 실시간 응답 |
| Groq LLaMA-4-Scout-17B | ~211ms | 무료 | 빠른 고품질 |
| Groq LLaMA-3.3-70B | ~225ms | 저렴 | 복잡한 빠른 추론 |
| Gemini 2.0 Flash | ~600ms | 무료 (OAuth) | 균형 |
| Claude Haiku 4 | 빠름 | $0.25/$1.25 | 프로덕션 경량 |
| Claude Sonnet 4.6 | 중간 | 중간 | 복잡한 판단 |

> ⚡ **핵심**: Groq가 Gemini보다 3배 빠름 → 투자봇 오케스트레이터 후보

---

## 2. LLM 기반 트레이딩 봇 최신 현황

### 주요 오픈소스 프로젝트

#### TradingAgents (가장 검증된 학술+실전 구현)
- 논문: arXiv:2412.20138 (2025 v7)
- GitHub: TauricResearch/TradingAgents
- **7개 에이전트 DAG 구조**:
  1. 펀더멘털 분석가
  2. 감성 분석가
  3. 뉴스 분석가
  4. 기술 분석가
  5. 리서처 (토론·종합)
  6. 트레이더 (의사결정)
  7. 리스크 매니저 + 펀드 매니저 (승인)
- 지원 모델: OpenAI, Anthropic, Google, xAI, Ollama
- 결과: 누적 수익률, 샤프비율, MDD 모두 기준선 대비 유의미한 개선

#### AI-Hedge-Fund Crypto (바이낸스 연동 실전)
- GitHub: 51bitquant/ai-hedge-fund-crypto
- LangGraph DAG + Binance Futures 실거래
- config.yaml로 기술분석 전략 구성
- 적응형 신호 가중치 조정

#### LLM_trader (비전 + 메모리)
- GitHub: qrak/LLM_trader
- 비주얼 코텍스(차트 인식) + 기술 전문가 + 감성 스카우트 + 메모리 히스토리안
- 진입 이유를 벡터 임베딩으로 저장 → 청산 시 Key Insight 학습

#### HedgeAgents (2025, 고성능)
- 논문: arXiv:2502.13165
- 3가지 에이전트 컨퍼런스 조율
- 결과: **연 70% 수익률, 3년 총 400%** (백테스팅)

### 핵심 교훈 (CoinDesk AI 트레이딩 보고)
> "GPT-5, DeepSeek, Gemini에게 각 $10,000을 줬을 때 원시 LLM은 '시장을 겨우 이겼다'"
> **LLM 단독 의사결정 < LLM 오케스트레이터 + 전문 ML 신호 조합**

---

## 3. 멀티에이전트 프레임워크

| 프레임워크 | 특징 | 트레이딩 적합도 |
|-----------|------|---------------|
| **LangGraph** | 그래프 기반, 상태 머신, 조건부 분기 | ⭐⭐⭐ 최적 |
| **CrewAI** | 역할 기반 팀 구조 | ⭐⭐ 우리 설계와 유사 |
| **AutoGen** | 대화형 에이전트 패싱 | ⭐⭐ |
| **OpenAI Agents SDK** | 2025년 3월 출시 (Swarm 후계) | ⭐⭐ |

> 72% 기업 AI 프로젝트가 멀티에이전트 채택 (2024년 23% → 2025년 72%)

---

## 4. 백테스팅 프레임워크

| 프레임워크 | LLM 연동 | 속도 | 추천 용도 |
|-----------|---------|------|---------|
| **VectorBT** | Python 훅 | 매우 빠름 (벡터화 NumPy) | 전략 파라미터 스윕 |
| **Freqtrade** | 내장 전략 콜백, REST 신호 수신 | 프로덕션급 | 실전 배포 |
| **Backtrader** | 이벤트 드리븐 훅 | 중간 | 클래식, 유연 |
| **FINSABER** | 네이티브 LLM 타이밍 | 연구급 | 편향 완화 |

> **추천 워크플로우**: VectorBT로 빠른 반복 검증 → Freqtrade로 실전 배포

---

## 5. 트레이딩 봇 메모리 아키텍처

### 메모리 계층 (2025 컨센서스)

```
[Working Memory] — 인컨텍스트
  현재 캔들, 오픈 포지션, 실시간 신호
        ↓
[Episodic Memory] — 벡터 DB (최근 거래)
  거래 진입 이유 (임베딩 저장)
  거래 결과 + P&L
  Key Insights 추출
  최근 100-500건
        ↓
[Semantic Memory] — 벡터 DB (장기 지식)
  시장 레짐 분류 (Bull/Bear/횡보)
  자산별 행동 패턴
  매크로 이벤트 영향
        ↓
[Procedural Memory] — 코드/설정
  진입/청산 로직, 리스크 룰
        ↓
[RAG — Knowledge Vault]
  뉴스 아카이브, 온체인 데이터
  ChromaDB / Qdrant
```

### 추천 메모리 라이브러리

- **Mem0** (GitHub: mem0ai/mem0)
  - F1 Score 28.64 — 메모리 검색 벤치마크 1위
  - 자동 사실 추출·업데이트
  - ChromaDB, Qdrant, PGVector, Redis 지원

- **FinMem** (arXiv:2311.13743)
  - Working/Long-term 계층 메모리
  - "캐릭터 디자인"으로 리스크 성향 조절
  - 주식 트레이딩 특화

---

## 6. 커뮤니티 감성 분석 소스

| 소스 | 특징 | API |
|------|------|-----|
| **LunarCrush** | 실시간 소셜+시장 인텔리전스 | 유료 |
| Reddit (PulseReddit) | 2024-2025 고빈도 트레이딩 데이터셋 | 무료 |
| X (트위터) | 선행 지표 (Reddit보다 빠름) | 유료 |
| Telegram 채널 | 한국 커뮤니티 | 직접 파싱 |
| DCInside 코인갤, 코인판 | 국내 감성 | 직접 파싱 |

> Reddit은 X보다 **후행 지표** — X가 먼저 움직임
> 도메인 파인튜닝된 LLM이 범용 LLM보다 감성 분석 우수

---

## 7. 우리 스택 최종 권장사항

| 항목 | 현재 계획 | 리서치 기반 업데이트 |
|------|---------|------------------|
| 투자봇 오케스트레이터 | claude-haiku-4-5-20251001 | **변경** (비용 절감, haiku 충분), Groq 보조 |
| 리서치봇 | gemini-2.0-flash | **유지** + LunarCrush API 추가 |
| 백테스팅 프레임워크 | backtrader + pandas-ta | **→ VectorBT 교체** (10x 빠름) |
| 실전 배포 | 직접 Binance API | **→ Freqtrade 위에 LLM 신호 주입** 고려 |
| 에이전트 프레임워크 | 직접 구현 | **→ LangGraph 채택** 고려 |
| 트레이드 메모리 | ChromaDB (기존) | **→ Mem0 라이브러리 추가** (자동 추출·업데이트) |
| 감성 소스 | Reddit/DCInside 직접 파싱 | **→ LunarCrush API 검토** |

---

## 참고 링크

- TradingAgents: https://github.com/TauricResearch/TradingAgents
- AI-Hedge-Fund Crypto: https://github.com/51bitquant/ai-hedge-fund-crypto
- LLM_trader: https://github.com/qrak/LLM_trader
- OctoBot: https://github.com/Drakkar-Software/OctoBot
- Mem0: https://github.com/mem0ai/mem0
- FinMem: https://github.com/pipiku915/FinMem-LLM-StockTrading
- VectorBT: https://vectorbt.dev/
- LunarCrush: https://lunarcrush.com/
- BFCL V4: https://gorilla.cs.berkeley.edu/leaderboard.html
- LangGraph: https://www.langchain.com/langgraph
- HedgeAgents 논문: https://arxiv.org/html/2502.13165v1
- TradingAgents 논문: https://arxiv.org/abs/2412.20138

---

*작성: 2026-02-27 | 최종 업데이트: 2026-03-02*
