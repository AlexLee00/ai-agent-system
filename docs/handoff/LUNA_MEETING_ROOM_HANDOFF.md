# 루나 투자회의 — 세션 핸드오프

> 버전 v0.2 (2026-06-08 갱신) · 작성: 메티 · 상태: **설계 v0.2 확정 · 영상 보강 진행 중(배치 1/3) · 구현 미착수**
> 3역할: 메티 작성 → 마스터 커밋. 문서 위치: `docs/design/{LUNA_MEETING_ROOM_DESIGN,LUNA_MEETING_ROOM_TRACKER,LUNA_VIDEO_REINFORCEMENT}.md` · `docs/handoff/이 파일`

## 0. 현재 상태 / 다음 세션 순서 (고정)
- **이번 세션 복원 완료**: DESIGN v0.2(18섹션, §16 검증계약·§17 3대결정 포함)·TRACKER v0.2(WS-A~H) 재생성. (이전 git reset로 v0.1 유실 → 복원.)
- **지속성**: `scripts/deploy.sh`(crontab */5)가 `git reset --hard FETCH_HEAD`로 미커밋 변경 폐기. **커밋만 하면 ancestor 가드가 보호 + auto-commit 푸시.** 작업 후 즉시 커밋 필수.
- **다음 세션**:
  1. (필요시) 지속성 확보 — 자동화 일시정지 또는 커밋-즉시.
  2. **영상 보강 배치 2**: 클로드코드퀀트(ZVMTeDBmSrI)·24시간(6MC1XqZSltw)·완전자동화(y_bsjZThP0o) + paperclip/Hermes/TradingView MCP 딥서칭. **배치 3**: 알고제왕(1SLbe0k6x4I)·주식시장(lH5wrfNwL3k)·단타(3L4LhT5lAWg)·매매분석(QaJnyy3-8Wg).
  3. **모든 배치 분석 후** 보강안(B-01~) + v0.2 → **DESIGN/TRACKER v0.3로 한번에 통합** → 커밋.
  4. v0.3 확정 후 → `docs/codex/CODEX_LUNA_MEETING_ROOM_PHASE1.md` 작성 → 코덱스 구현 → 메티 독립검증 → 마스터 커밋.

## 1. 설계 v0.2 핵심 (요약)
- 철학: 실험 우선 · 성능 비중 · **가드 최소("게이트 치우고 계측 깐다")**. 유지 3개: 실거래/자금이동=마스터 행동 · point-in-time/누수 차단 · crypto LIVE/스카 무중단. 나머지 게이트=advisory.
- C1 자율=마스터 다이얼+earned 텔레메트리(LUNA_AUTONOMY_PHASES 정렬) · C2 백테=CPCV 교체+DSR/PBO/MinTRL 리더보드 · C3 기억=temporal-validity+CVRF 신념층 · C4 의사결정=듀얼(제약형+자유섀도) · C5 토론=적응종료+이종모델.
- 6 Lane: Research/Decision(Luna 제약)/Policy(Nemesis)/Execution/**Validation(약→코어 승격)**/Review. 안건 8 FSM=레인 구동 뷰.

## 2. 회의 트리거 · 일정 (확정)
- 트리거=웹 "회의 시작" 버튼(휴장일 비활성+팝업, 수시 겸함) → `POST :7788/luna/meeting/start`.
- 일일 05:00–06:00 KST 창(거래일) → 미클릭 시 폴백 launchd(hour=6) 루나 시작. 주간 일요일 06:00–07:00 → 폴백(weekday=0,hour=7).
- launchd=폴백 워처(비-PROTECTED). 이번 주=버튼 수동 → 다음 주=정례화.

## 3. 3대 구현 결정 (확정)
1. paper 주문=별도 paper 원장(DB); LIVE(다이얼) 시만 l31+kis-client.
2. Hub=meeting-room 독립 loopback(index.ts)+`hub-proxy` 프록시(route-registry 마운트 아님).
3. 이종 모델=불(zeus)=Claude/베어(athena)=OpenAI. zeus.yaml `llm_routing.primary`→claude. (현재 둘 다 gpt-5.4-mini.)

## 4. 영상 보강 진행 (LUNA_VIDEO_REINFORCEMENT.md)
- **배치 1 완료(6편)**: 보강안 B-01~B-09 + grill 스킬 외부확보(mattpocock/skills, ADR 3기준·CONTEXT.md=글로사리).
  - 강력권장: B-01 ADR 결정기록 · B-06 한-변수 과학적 자기개선. 그 외 B-05 성공/실패 스코어러·B-02 CONTEXT.md·B-03 grill 자기심문·B-07 CEO 단일창구·B-08 비용최적화·B-09 agent-view 병렬뷰.
  - 평가 대기 도구: paperclip·Hermes agent·agent-view(배치 2 딥서칭).
- 자막 캐시 `/tmp/ytdistill/clean/`(13개) + `/tmp/yt-dlp` 바이너리. 유실 시 재취득.

## 5. 불변 · 안전
- 3역할 절차 · PROTECTED launchd 무중단 · crypto LIVE·스카 무중단 · 자동 부작용 금지 · 부품 재사용 우선(오케스트레이터만 신규) · loopback 전용.

## 6. 외부 레퍼런스 (재조사 불필요)
- anthropics/financial-services(SKILL.md·morning-note·ic-memo·이중배포·check.py drift CI) · TradingAgents·FinCon(CVRF)·FinMem · 한국 MCP(korea-stock-mcp·korea-stock-analyzer·네이버) · 메모리(Mem0·Letta·Zep/Graphiti temporal) · 금융 rigor(누수·DSR/PBO/CPCV·LiveTradeBench·BlindTrade) · mattpocock/skills(grill).

## 7. 참고 세션 산출물
- 트랜스크립트: `2026-06-08-12-03-47-luna-meeting-room-design` 외. UI 목업 2종 · 영상 분석 배치 1.
