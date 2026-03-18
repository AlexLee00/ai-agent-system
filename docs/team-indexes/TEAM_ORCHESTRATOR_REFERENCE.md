# 제이/오케스트레이터 참조 문서

## 역할

- 메인봇 라우팅
- 팀별 헬스/리포트/인텐트/브리핑 허브

## 핵심 기능

- 자연어 명령 라우팅
- 팀별 상태 요약
- n8n critical path 점검
- 인텐트/피드백/리포팅 조회

## 모델 체계

- OpenClaw gateway 기본 모델
  - 외부 설정 파일: [openclaw.json](/Users/alexlee/.openclaw/openclaw.json)
  - 현재 primary: `google-gemini-cli/gemini-2.5-flash`
- 제이 명령 해석 모델
  - 파일: [intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)
  - 기본값: `gpt-5-mini`
  - fallback 기본값: `gemini-2.5-flash`
- 제이 자유대화 fallback 체인
  - 파일: [router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)
  - 기본 chain: `groq/openai/gpt-oss-20b -> google-gemini-cli/gemini-2.5-flash`
- 정책 집약 파일
  - [jay-model-policy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/jay-model-policy.js)
  - 의미: OpenClaw 기본 모델과 별개로, 제이 앱 레벨 커스텀 모델 정책을 한 곳에서 관리
  - 실제 운영값은 [config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)의 `runtime_config.jayModels`에서 오버라이드 가능
- gateway 정합성 점검/동기화
  - [check-jay-gateway-primary.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js)
  - 의미: `runtime_config.jayModels.gatewayPrimary`와 `~/.openclaw/openclaw.json`의 실제 primary 일치 여부를 확인
  - 후보 프로필: Gemini 유지 / Groq GPT-OSS / Anthropic Haiku
  - 현재 권장: 정합성이 맞고 헬스가 안정이면 Gemini Flash 유지, 변경은 비교 근거가 쌓인 뒤 검토
  - 전환 기준:
    - `hold`: 정합성 일치 + health-report `hold` 구간이면 유지
    - `compare`: rate limit 재발, fallback 의존 증가, 체감 응답속도 불만 누적 시 후보 비교
    - `switch`: 비교 로그에서 더 낮은 rate limit, 더 나은 응답시간, 더 안정적 성공률이 확인되면 전환
  - 필요 시 `--apply`로 OpenClaw primary를 runtime_config 기준으로 동기화 가능
- gateway 실험 로그 스냅샷
  - [log-jay-gateway-experiment.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/log-jay-gateway-experiment.js)
  - 의미: gateway 로그, 제이 usage, health-report, primary 정합성을 한 번에 스냅샷으로 저장
  - 기본 저장 위치: `~/.openclaw/workspace/jay-gateway-experiments.jsonl`
- gateway 실험 리뷰
  - [jay-gateway-experiment-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-review.js)
  - 의미: 누적 스냅샷을 읽어 `hold / compare / sync_first` 권장 판단으로 요약

## 핵심 진입점

- [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)
- [bots/orchestrator/lib/intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)

## 운영 스크립트/설정

- [bots/orchestrator/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js)
- [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)
- [bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
- [bots/orchestrator/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/runtime-config.js)

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js --json
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/log-jay-gateway-experiment.js --hours=24 --json
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-review.js --days=7 --json
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-daily-review.js --days=1
# 제이 명령으로 조회:
# /jay-models
# "제이 지금 무슨 모델 써?"
```

## 관련 문서

- [bots/orchestrator/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/DEV_SUMMARY.md)
- [bots/orchestrator/context/HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/HANDOFF.md)
- [bots/orchestrator/context/TEAMS.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/TEAMS.md)
