# B5-0 — 블로 작성 에이전트 액션 로직 재검토 보고서 (1차)

작성: 메티(Meti) / 2026-06-13 / 원천: BLO_AGENT_WRITER_REDESIGN §3 B5-0 (마스터 지시 6/13)

## 1. 플로우 맵 (실측 — blo.ts 2,697줄 구조 추적)
run(2660) -> _runLectureStage(2373, _runWithStageRetry 래퍼) + _runGeneralStage(2411)
[강의] isSeriesComplete -> rotation 강의 결정 -> **agenticSearch(RAG, 3건)** -> 스케줄 'writing' ->
prepareCompetition -> runLecturePost: 작가 선택(hiringContract.selectBestAgent) -> 리서치 ->
vault-context '[지난 강의 연계]'(B2) + masterStyleHint(analyzer, B2c) -> 작성 -> humanize(목표 80점,
2회 시도) -> 품질 -> repair 루프(1038) -> publishToFile -> 스케줄 'scheduled' -> 성과 기록 -> 경험 축적.
[일반] 유사 구조 + 크로스포스트 분기(아래 F1).
종합 평가: **골격 건전** — 재시도 래퍼/품질-repair 루프/경험 축적의 순서·책임 분리는 적절.

## 2. 발견 (우선순위순)
- **F1. 인스타 크로스포스트 경로 잔존 + env 가드 부재**(1678/1897): quota 체크만 있고 소셜 off 방침
  가드 없음. instaContent.reel 생성 여부에 의존해 자연 skip일 수 있으나 구조적 불일치 — 라이브 로그로
  실동작 확인 후 가드(BLOG_SOCIAL_CROSSPOST_ENABLED=false) 또는 경로 제거 권고.
- **F2. RAG 이중화**: agenticSearch(기존, 강의 진입 시 3건) + vault-context(B2 신규, 작성 프롬프트 주입)
  가 강의 경로에 공존. 소스·목적 중복 여부 정독 필요 -> 역할 분리 명시(예: agentic=토픽 리서치,
  vault=과거 강의 연계) 또는 통합.
- F3. 죽은 코드 후보: 인스타 reel 콘텐츠 생성 경로(social-media 분리 후 실효성 의문).
- F4. (긍정) B2/B2c 주입 지점이 의도한 위치에 정확히 통합돼 있음 — 추가 보정 불요.

## 3. 미정 (2차 정독 대상)
runLecturePost 내부 세부 단계 / maestro.ts와 blo.ts의 책임 경계(REFACTOR_AUDIT Next 항목과 연결) /
gems-writer(일반) 경로 세부 / prepareCompetition의 현 역할.

## 4. 마스터 결정 (2026-06-13 확정)
- **F1·F3: 제거 확정** — 크로스포스트 호출 경로 + 인스타 reel 생성 경로 삭제(더 이상 사용 안 함.
  bots/social-media 코드·MCP 툴은 차후 확장용으로 보존 원칙 유지).
- **F2: 통합 확정** — RAG 이중화 해소("이중화하면 관리가 어려워진다"). 방향: vault-context(대도서관)로
  일원화하고 agenticSearch의 역할을 흡수 검토 — 통합 설계는 CODEX-B5a에서 구체화(소스 차이 정독 포함).
- **F4: 그대로 진행** (B2·B2c 주입 정위치 유지).
- 실행: **CODEX-B5a(F1·F3 제거 + F2 통합)** — 다음 세션에서 프롬프트 작성. B4/B5 재설계 입력 = §1 플로우 맵.
