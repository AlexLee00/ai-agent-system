# 루나 시스템 재점검 Phase Codex 프롬프트

아래 프롬프트를 그대로 Codex에 넣어 실행한다.

```text
/Users/alexlee/projects/ai-agent-system 기준으로 작업한다.

목표:
루나팀 자동매매 시스템을 부분 보완이 아닌 시스템 단위로 재점검한다.
이번 라운드의 목적은 기능 추가가 아니라, 부분 보완으로 충분한지 또는 재설계가 필요한지 판단하는 것이다.

반드시 한국어로만 답변하라.
스스로를 "코덱"이라고 표현하라.

중요 관점:
1. 비즈니스 목표
2. 서비스 기획 구조
3. 개발 실현 가능성
4. 데이터 구조 및 확장성
5. 운영 안정성
6. 추후 SaaS 확장 가능성

작업 원칙:
- 전면 재설계부터 시작하지 마라.
- 먼저 현재 구조를 정확히 계측하고, 병목 위치를 코드/데이터 기준으로 확정하라.
- 새 외부 API나 새 프레임워크를 끼워 넣지 마라.
- 기존 레이어를 최대한 재사용하라.
- 민감정보/토큰/계좌정보는 절대 노출하지 마라.
- tmp 산출물은 커밋하지 마라.

이번 라운드의 핵심 질문:
1. 종목 선정 연구는 충분히 다양한가?
2. 연구 결과가 심볼 decision으로 충분히 승격되는가?
3. 심볼 decision이 portfolio decision에서 과도하게 HOLD로 소거되는가?
4. risk 레이어가 실제 병목인가?
5. execution 레이어가 실제 병목인가?
6. 시장별로 부분 보완이 가능한가, 아니면 재설계가 필요한가?

필수 확인 경로:
- /Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-db.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml
- /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js
- /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js
- /Users/alexlee/projects/ai-agent-system/docs/LUNA_RESET_AUDIT_PLAN_2026-03-19.md

필수 산출물:
1. 루나 시스템 현황 진단서
2. 레이어별 병목 보고서
3. 부분 보완안 vs 재설계안 비교안

반드시 아래 순서로 진행하라:
1. 현재 구조와 최근 운영 데이터 재확인
2. 시장별 퍼널 수치 정리
3. 병목 위치를 레이어별로 분해
4. 부분 보완 가능 범위 판단
5. 재설계가 필요한 경우 최소 재설계 단위를 제안

응답 형식:
1) 결론
2) 이유
3) 구현/설계 포인트
4) 리스크 또는 TODO
5) 다음 단계

이번 라운드에서는 성급히 구현하지 말고, 진단과 판단을 우선하라.
단, 리포트/계측 보강처럼 진단에 꼭 필요한 최소 코드 수정은 허용한다.
```
