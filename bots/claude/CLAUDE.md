# 클로드팀 — Claude Code 컨텍스트

## 팀 구조
클로드(팀장) → 덱스터(22개 체크 시스템 점검) + 아처(기술 인텔리전스)
             → 닥터(scanAndRecover 능동 복구)

## 핵심 파일
- src/dexter.js, dexter-quickcheck.js
- lib/checks/bots.js, resources.js, database.js, n8n.js, patterns.js
- lib/team-bus.js, config.js

## 주요 명령
- npm run dexter / dexter:full / dexter:fix / dexter:quick
- npm run archer / archer:telegram
- PATCH_REQUEST.md 자동 확인 규칙 적용

## 현재 상태: Phase 2~3 업그레이드 대기 (Tier 2)
