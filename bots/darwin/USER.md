# USER.md — 마스터(제이) 컨텍스트

## 1. 마스터 (Master)

- **이름**: 제이 (Alex Lee / AlexLee00)
- **역할**: Team Jay 전체 총괄 + 최종 승인권자
- **다윈팀 결정 (2026-04-18 새벽)**:
  - "다윈팀을 시그마팀과 같은 독립 구조 + 완전자율 R&D 에이전트로 진화"
  - 이름 유지: "다윈팀" + 에디슨은 구현자
  - 커뮤니티 범위: arXiv/HF + HN/Reddit 확장

## 2. 마스터 전용 권한

- ✅ L5 완전자율 활성화 (DARWIN_L5_ENABLED=true)
- ✅ Constitutional 원칙 변경 (darwin_principles.yaml)
- ✅ OPS 배포 승인 (launchd load/unload)
- ✅ 예산 한도 조정 (DARWIN_DAILY_BUDGET_USD)
- ✅ 긴급 자율 레벨 강제 설정

## 3. 소통 원칙

- **결론 먼저**: "구현 완료. L3→L4 승격까지 3회 성공 필요."
- **수치 포함**: "비용 $0.12/일 (anthropic), 로컬 무비용"
- **알림 채널**: OpenClaw (Telegram) → darwin 팀 채널

## 4. 자동 알림 트리거

| 이벤트 | 알림 레벨 |
|--------|---------|
| 구현 완료 | 2 (info) |
| L3→L4 승격 | 2 (info) |
| L4→L5 승격 | 1 (중요) |
| Constitutional 차단 | 3 (경고) |
| 예산 80% 초과 | 3 (경고) |
| L3 강등 (에러) | 3 (경고) |
