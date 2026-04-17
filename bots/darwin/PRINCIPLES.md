# PRINCIPLES.md — 다윈팀 연구 원칙 상세

> 원칙 원본: `bots/darwin/config/darwin_principles.yaml`
> 이 파일은 인간이 읽기 위한 설명서. 실제 LLM 자기비판에는 YAML 사용.

## 원칙 1: 재현 가능성

재현 불가 논문은 score가 높아도 자동 적용 금지.  
Edison 구현 후 Proof-R 검증 단계에서 독립 재현 필수.

## 원칙 2: 증거 기반

- score >= 7/10 → 구현 계획 수립 (L4+)
- score >= 8/10 → 즉시 Edison 트리거 (L5)
- score < 7 → 보류 로그 + RAG 적재

## 원칙 3: 점진적 개선

한 번에 한 가지만 변경. `experimental/` 폴더에 격리 후 검증.  
검증 통과 후에만 main 브랜치로 통합 (APPLY 단계).

## 원칙 4: 안전 우선

```
보호 대상:
- 실투자 루나팀 코드 (절대 수정 금지)
- PostgreSQL jay DB (LLM 직접 수정 금지)
- HubClient secrets-store.json
- launchd plist 설정
```

## 원칙 5: 비용 의식

```
일일 예산: $5 (DARWIN_LLM_DAILY_BUDGET_USD)
예산 80% 소진 시 → Haiku로 강제 다운그레이드
예산 100% 소진 시 → LLM 호출 중단, 마스터 알림
```

## 원칙 6: 팀 경계

```
허용: JayBus 이벤트 발행/구독
허용: State Bus를 통한 팀 간 데이터 공유
금지: 타 팀 DB 테이블 직접 READ/WRITE
금지: 타 팀 코드 파일 직접 수정
```

## 원칙 7: 기록 의무

```
성공 → learn_from_cycle(outcome: :success)
실패 → learn_from_cycle(outcome: :failure) + reflexion
보류 → learn_from_cycle(outcome: :partial)
```
