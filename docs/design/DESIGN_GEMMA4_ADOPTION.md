# Gemma 4 도입 설계 — 우리 시스템에서 어디에, 어떻게 시험할 것인가

> 작성: Codex
> 작성일: 2026-04-03
> 기준: 공식 발표 + 배포 생태계 + 로컬 커뮤니티 초기 반응

---

## 1. 결론 요약

```
Gemma 4는 "지금 바로 전면 교체"보다
"경량 로컬 에이전트와 구조화 출력 태스크에 후보로 투입"이 맞다.

우선 도입 위치:
  1) worker assistant/intake
  2) blog summarize/research 보조
  3) sigma quality/analysis 보조
  4) video 구조화 분석 보조

보류 위치:
  - luna 핵심 투자판단
  - justin 인용/법률 검증
  - darwin 심층 연구 검증
```

### 현재 운영 상태 (2026-04-11)

```
실제 운영 연결:
  - blog / gemma-topic
  - orchestrator / gemma-insight
  - ska / gemma-insight

서빙 경로:
  - hub runtime profile -> local http://127.0.0.1:11434
  - model: gemma4:latest
  - backing model: mlx-community/gemma-4-e2b-it-4bit

참고:
  - 현재 production Gemma 호출의 source of truth는 gemma-pilot 경로
```

---

## 2. 외부 평가 요약

### 2-1. 공식 시그널

Gemma 4는 다음 포지션으로 읽힌다.

```
- 오픈 모델
- agent/tool use 친화
- JSON / function calling / structured output 강조
- 멀티모달 + 다국어
- edge / on-device / private deployment 지향
```

핵심 해석:

```
Gemma 4의 가장 강한 가치는
"큰 클라우드 모델 대체"보다
"로컬에서 꽤 똑똑한 agent 작업을 저렴하게 돌리는 것"이다.
```

### 2-2. 커뮤니티 반응 요약

초기 반응은 대체로 다음 톤이다.

```
긍정:
  - small model 체급 대비 성능 기대가 크다
  - 24GB급 GPU / edge 장비에서 의미가 크다
  - Google 생태계 + 배포 친화성이 좋다

보수:
  - Qwen과 비교한 중형 라인 경쟁력은 더 봐야 한다
  - 코딩/사실성 절대 성능은 아직 검증 중이다
  - 출시 초반이라 실사용 장기 데이터는 부족하다
```

---

## 3. 우리 시스템 기준 판단

### 3-1. 잘 맞는 곳

```
1. 구조화 출력
   - JSON 강제
   - 필드 추출
   - 등급/분류

2. 경량 agent
   - 리뷰 보조
   - 모니터링 요약
   - intake triage
   - 데이터 품질 점검

3. 로컬/엣지 실행
   - 비용 민감
   - 지연시간보다 호출량이 중요한 곳
   - 외부 quota 의존을 줄이고 싶은 곳
```

### 3-2. 아직 보수적으로 봐야 하는 곳

```
1. 실투자 판단
2. 법률 인용 검증
3. 심층 연구 검증 / 재현성 판단
4. 장문 한국어 본문 생성 주력
```

이 영역은 현재 기준으로:

```
claude-code/sonnet
openai-oauth/gpt-5.4
groq scout
```

같은 이미 검증된 체인을 유지하는 편이 안전하다.

---

## 4. 팀별 도입 우선순위

### 4-1. 1차 도입

#### worker

```
대상:
  - assistant
  - intake

역할:
  - 짧은 응답
  - 분류/정리
  - 라우팅 전처리

도입 방식:
  - primary는 유지
  - Gemma 4를 candidate/fallback으로 추가
```

#### blog

```
대상:
  - social summarize
  - star summarize
  - richer/bookmark 계열 보조 research

역할:
  - 짧은 요약
  - 구조화 보조
  - 자료 정리

주의:
  - 장문 본문 생성 주력(writer)에는 바로 넣지 않는다
```

#### sigma

```
대상:
  - quality
  - feature planning 보조
  - observability 설명 생성

역할:
  - JSON 안정성
  - 이상 징후 설명
  - 분류/정리
```

#### video

```
대상:
  - scene indexer 보조
  - narration analyzer 보조
  - subtitle correction 보조

역할:
  - 구조화 분석
  - 구간/태그/설명 생성
```

### 4-2. 2차 도입

```
darwin:
  search summary / synthesis 보조만 후보

justin:
  초안 보조/구조화 보조만 후보
  citation verifier 주력은 보류

luna:
  감시/요약/보조 분석만 후보
  최종 판단/실행 관련 route는 보류
```

---

## 5. 도입 방식

### 5-1. 원칙

```
primary 교체가 아니라
candidate 또는 late fallback으로 붙인다
```

예:

```yaml
worker.assistant:
  primary:
    - claude-code/sonnet
    - openai-oauth/gpt-5.4-mini
  candidate:
    - local/gemma-4
```

또는:

```yaml
sigma.quality:
  primary:
    - openai-oauth/gpt-5.4
  fallback:
    - local/gemma-4
    - local/qwen2.5-7b
```

### 5-2. 비교 기준

```
1. success_rate
2. avg_latency_ms
3. JSON parse success
4. hallucination / field omission
5. cost / local resource use
6. 한국어 자연스러움
```

---

## 6. A/B 테스트 정책

### 6-1. 실행 범위

```
Phase A:
  worker / sigma / video 일부 selector만

Phase B:
  blog summarize/research 보조

Phase C:
  darwin / justin 보조 경로 일부
```

### 6-2. 승격 조건

Gemma 4를 fallback에서 candidate 또는 primary로 올리려면:

```
- success_rate가 기존 대비 같거나 높을 것
- JSON 실패율이 더 낮거나 비슷할 것
- 평균 지연이 허용 범위 내일 것
- hallucination 이슈가 늘지 않을 것
```

---

## 7. 구현 범위 제안

### 7-1. 필요한 것

```
1. local model registry에 Gemma 4 추가
2. llm-model-selector.js에 gemma route 추가
3. worker/sigma/video 일부 selector에 candidate route 추가
4. llm_model_eval trace 비교
5. 결과 문서화
```

### 7-2. 지금 당장 하지 않을 것

```
- 블로그 writer primary 교체
- luna 실전 route 교체
- justin citation verifier primary 교체
- darwin reviewer/replicator primary 교체
```

---

## 8. 최종 권고

```
Gemma 4는 유망하다.
하지만 우리 시스템에서는
"Qwen 대체 전체 교체"가 아니라
"구조화/경량/로컬 보조 경로"부터 시험 도입하는 것이 맞다.
```

초기 설계상 추천 순서:

```
1. worker
2. sigma
3. video
4. blog summarize/research
5. 그 다음 darwin / justin 보조 경로
```

현재 반영 순서:

```
1. blog
2. orchestrator
3. ska
```
