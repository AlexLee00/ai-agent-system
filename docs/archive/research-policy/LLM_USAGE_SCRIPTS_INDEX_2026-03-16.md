# LLM 사용량 스크립트 정리

## 목적

LLM 사용량 스크립트가 서로 겹쳐 보이지 않도록 역할을 분리한다.

## 스크립트 구분

### 1. OpenClaw API 로그 전용

- 파일:
  - `/Users/alexlee/projects/ai-agent-system/scripts/api-usage-report.js`
- 의미:
  - `~/.openclaw/api-usage.jsonl` 기반 단일 로그 리포트
- 용도:
  - provider/model별 일일 API 로그 확인
- 주의:
  - Jay 전체 세션 사용량을 대표하지 않음
  - DB 통합 로그도 포함하지 않음

### 2. Jay 전용 세션 사용량

- 파일:
  - `/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-usage-report.js`
  - `/Users/alexlee/projects/ai-agent-system/scripts/reviews/lib/jay-usage.js`
- 의미:
  - `~/.openclaw/agents/main/sessions/*.jsonl` 기반
- 용도:
  - Jay/OpenClaw 실제 세션 사용량
  - 모델별/일별 사용량

### 3. 전체 봇 통합 사용량

- 파일:
  - `/Users/alexlee/projects/ai-agent-system/scripts/llm-usage-unified-report.js`
- 의미:
  - `claude.token_usage`
  - `reservation.llm_usage_log`
  - Jay OpenClaw 세션 사용량
  를 함께 본다
- 용도:
  - 전체 봇 사용량 피드백
  - 팀별/봇별 상위 사용량 확인

## 운영 원칙

- `api-usage-report.js`는 레거시/단일 로그 성격으로 유지
- Jay 분석은 `scripts/reviews/jay-llm-usage-report.js`를 우선 사용
- 전체 피드백/자동화는 `llm-usage-unified-report.js`를 기준으로 확장

## 실행 예시

```bash
node /Users/alexlee/projects/ai-agent-system/scripts/api-usage-report.js
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-usage-report.js --days=14
node /Users/alexlee/projects/ai-agent-system/scripts/llm-usage-unified-report.js --days=7
```
