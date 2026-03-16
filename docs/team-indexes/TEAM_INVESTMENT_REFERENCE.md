# 루나 참조 문서

## 역할

- 암호화폐/국내장/해외장 자동매매
- 시장별 분석, 리스크 승인, 실행, 리뷰 자동화

## 핵심 기능

- `luna` 최종 판단
- `nemesis` 리스크 승인
- `hanul` KIS 실행
- 시장별 일일/주간 리뷰
- `runtime_config` 기반 공격성/보수성 조정

## 핵심 진입점

- [bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- [bots/investment/team/hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
- [bots/investment/markets/crypto.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js)
- [bots/investment/markets/domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
- [bots/investment/markets/overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)

## 핵심 스크립트

- [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

## 운영 설정

- [bots/investment/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
- [bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
- [bots/investment/shared/secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
- [bots/investment/shared/report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/report.js)

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js --dry-run
node /Users/alexlee/projects/ai-agent-system/bots/investment/manual/balance/binance-balance.js
```

## 관련 문서

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md](/Users/alexlee/projects/ai-agent-system/docs/COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md)
- [improvement-ideas.md](/Users/alexlee/projects/ai-agent-system/docs/improvement-ideas.md)
