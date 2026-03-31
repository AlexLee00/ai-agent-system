# 클로드팀 — Claude Code 컨텍스트

## 팀 구조 (보강 계획 포함)
클로드(팀장)
  [운영] 덱스터 — 22개 체크 시스템 점검 (감지)
  [운영] 아처 — 기술 인텔리전스
  [운영+강화] 닥터 — 복구 전문가 (L1 재시작 + L2 설정 + L3 코드패치)
  [신설 예정] 리뷰어 — 코드 리뷰 자동화
  [신설 예정] 가디언 — 보안 분석 (6계층)
  [신설 예정] 빌더 — 빌드/배포 자동화 (워커 Next.js + npm)

## 핵심 파일
- src/dexter.js, dexter-quickcheck.js
- lib/checks/bots.js, resources.js, database.js, n8n.js, patterns.js
- lib/team-bus.js, config.js

## 참고: Claude Forge 패턴 (github.com/sangrokjung/claude-forge)
- /plan→/tdd→/code-review→/handoff-verify→/commit-push-pr 파이프라인
- 6계층 보안 훅 패턴
- /verify-loop 자동 수정 재시도 패턴

## 현재 상태: 운영 안정 + 보강 설계 완료 (Tier 2에서 구현)
