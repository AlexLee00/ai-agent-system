# TRACKER.md — 다윈팀 작업 추적

> 최종 업데이트: 2026-04-18 (40차 세션)

## 현재 상태 요약

```
자율 레벨: L4 (path_error_fixed_prototypes_allowed)
연속 성공: 0 (리모델링 후 리셋)
적용 성공: 0
마지막 스캔: -
마지막 구현: -
```

## 40차 세션 작업 내역

### 완료
- [x] CODEX_DARWIN_REMODEL Phase 0-5 전체 구현
- [x] bots/darwin/elixir/ 독립 구조 확립
- [x] Darwin.V2.* 네임스페이스 20+ 모듈 생성
- [x] mix.exs에 darwin elixir lib 경로 추가
- [x] application.ex에 Darwin.V2.Supervisor 등록
- [x] DB 마이그레이션 생성 (darwin_v2_llm_cost_tracking, routing_log)
- [x] 표준 md 문서 9개 생성

### 다음 작업 (41차 세션)
- [ ] `mix compile --warnings-as-errors` 검증 + 오류 수정
- [ ] Phase 6: Shadow Mode (Darwin.V2.ShadowRunner)
- [ ] DB 마이그레이션 OPS에 적용
- [ ] DARWIN_V2_ENABLED=true OPS 환경변수 설정
- [ ] 테스트 파일 생성 (최소 20개)
- [ ] Cycle GenServer 실제 비즈니스 로직 구현

## 파일 목록 (Darwin V2)

```
bots/darwin/elixir/lib/darwin/v2/
├── supervisor.ex           ✅ (기존)
├── kill_switch.ex          ✅ (기존)
├── signal.ex               ✅ 신규
├── autonomy_level.ex       ✅ 신규
├── reflexion.ex            ✅ 신규
├── self_rag.ex             ✅ 신규
├── espl.ex                 ✅ 신규
├── memory.ex               ✅ 신규
├── memory/
│   ├── l1_session.ex       ✅ 신규
│   └── l2_pgvector.ex      ✅ 신규
├── llm/
│   ├── selector.ex         ✅ 신규
│   ├── cost_tracker.ex     ✅ 신규
│   └── routing_log.ex      ✅ 신규
├── principle/
│   └── loader.ex           ✅ 신규
├── skill/
│   ├── evaluate_paper.ex   ✅ 신규
│   ├── plan_implementation.ex ✅ 신규
│   └── learn_from_cycle.ex ✅ 신규
├── cycle/
│   ├── discover.ex         ✅ 신규
│   ├── evaluate.ex         ✅ 신규
│   ├── plan.ex             ✅ 신규
│   ├── implement.ex        ✅ 신규
│   ├── verify.ex           ✅ 신규
│   ├── apply.ex            ✅ 신규
│   └── learn.ex            ✅ 신규
├── mcp/
│   └── server.ex           ✅ 신규
└── commander.ex            ✅ 신규
```
