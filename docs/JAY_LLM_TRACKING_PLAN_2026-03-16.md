# 제이 LLM 라우팅 및 사용량 추적 계획

## 오늘 반영한 것

- 명령형 인텐트 LLM 폴백:
  - OpenAI `gpt-5-mini` 우선
  - 실패 시 Gemini `gemini-2.5-flash` 폴백
- 제이 자유대화 폴백:
  - `gpt-oss-20b` 우선
  - 실패 시 `gemini-2.5-flash`
- 오케스트레이터 LLM 호출 로그:
  - `claude.token_usage`
  - `reservation.llm_usage_log`
  둘 다 기록
- 제이 전용 사용량 리포트:
  - `scripts/reviews/jay-llm-usage-report.js`
- 전체 봇 통합 사용량 리포트:
  - `scripts/llm-usage-unified-report.js`

## 목적

- 제이의 명령형 경로는 의미 보존을 더 강하게 가져간다.
- 제이 전체 트래픽을 OpenAI로 옮기지 않고, 자유대화는 빠른 무료 모델 체인으로 유지한다.
- OpenClaw 세션 기반 실제 사용량을 별도 추적한다.
- DB 로그와 OpenClaw 세션 로그를 함께 봐서 팀별 피드백에 활용한다.

## 운영 규칙

### 제이 명령형

- 대상:
  - 인텐트 분류용 LLM 폴백
- 모델:
  - `gpt-5-mini`
- 실패 시:
  - `gemini-2.5-flash`

### 제이 자유대화

- 대상:
  - `chat` fallback
- 모델:
  - `openai/gpt-oss-20b`
- 실패 시:
  - `gemini-2.5-flash`

## 리포트 명령

```bash
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-usage-report.js --days=14
node /Users/alexlee/projects/ai-agent-system/scripts/llm-usage-unified-report.js --days=7
```

## 다음 추적 포인트

- 제이 명령형에서 `gpt-5-mini` 토큰 소모량
- `command_parse` 성공률 변화
- `gpt-oss-20b` 자유대화 응답 품질과 속도
- Gemini 최종 폴백 발생 빈도
- 팀별/봇별 상위 모델 분포
- 일일/주간 자동 피드백 연결 여부
