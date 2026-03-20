# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-21 (4차 세션)
> 담당: 메티 (claude.ai Opus)
> 상태: 과제 1~7 핵심 구현 완료 + worker-web 영상 편집 API/UI 연결 완료 + 운영 안정화 단계

---

## 이번 세션에서 완료한 것

### 1. 과제 5: CapCutAPI 드래프트 생성 ✅
- CapCutAPI 설치 (/Users/alexlee/projects/CapCutAPI)
- Flask 서버 localhost:9001 정상 동작
- lib/capcut-draft-builder.js (12개 함수)
- 테스트 전체 통과 (healthCheck → buildDraft 통합)
- CapCut Desktop 프로젝트 목록에 드래프트 카드 표시 확인

### 2. CapCut 문제 발견 + 아키텍처 변경 결정
발견된 문제:
- CapCutAPI가 생성한 draft_info.json: tracks=0, materials 전부 비어있음
- CapCut 7.2.0 수동 편집 드래프트: draft_info.json 암호화 (JSON 파싱 불가)
- 즉 "CapCut 편집 → draft 파싱 → FFmpeg 렌더링" 전략 폐기

결정:
- EDL JSON (편집 결정 목록) 기반 아키텍처로 전환
- CapCutAPI는 선택적 보조 프리뷰로 유지 (--with-capcut)
- RED/BLUE 팀이 영상 편집(컷/효과/전환)까지 관여
- 프리뷰는 FFmpeg 720p 또는 워커 웹 HTML5 Video+VTT

### 3. CapCut 대안 조사
- 8개 도구 비교: FFmpeg, Editly, Remotion, MoviePy, Shotstack 등
- MVP: FFmpeg + EDL JSON (즉시 적용)
- SaaS 확장: Remotion (Phase 2)
- llm-video-editor 패턴 참고 (LLM → EDL JSON → FFmpeg)

### 4. 문서 업데이트 (Step 1~3 완료)

Step 1 — 문서 업데이트:
  ✅ CLAUDE.md: EDL JSON 섹션 추가, 절대 규칙 11~13 추가, CapCutAPI→선택적 보조
  ✅ VIDEO_HANDOFF.md: 아키텍처 요약 교체, UX Step 6 변경, 상태 라인 갱신
  ✅ video-team-design.md: 모듈 테이블(video-analyzer, edl-builder), 섹션 3-2/3-3/3-4 교체
  ✅ video-team-tasks.md: 과제 6 재정의, 과제 10~12 재정의

Step 2 — 과제 1~5 수정사항 점검:
  ✅ 과제 2~4: CapCut 참조 없음 — 수정 불필요
  ✅ 과제 5: 코드 유지 (선택적 보조), 다른 모듈에서 직접 의존 없음
  ✅ config: capcut_api 섹션 유지 (선택적)

Step 3 — 과제 6~13 재정의:
  ✅ 과제 6: "영상 분석 + EDL 생성 + FFmpeg 렌더링" (video-analyzer + edl-builder)
  ✅ 과제 7: EDL 기반 파이프라인 통합 (--with-capcut 선택적)
  ✅ 과제 10: Critic → 자막+오디오+★영상 구조 분석 → critic_report.json
  ✅ 과제 11: Refiner → SRT 수정 + ★EDL JSON 생성/수정
  ✅ 과제 12: Evaluator → EDL 기반 프리뷰 재생성 + 영상제작팀 피드백 루프

### 5. 과제 7: run-pipeline 1차 통합 ✅
- `bots/video/scripts/run-pipeline.js` 추가
- `bots/video/src/index.js`를 `loadConfig()` export 구조로 리팩터링
- 통합 흐름:
  - source 선택
  - `video_edits` INSERT
  - 전처리
  - Whisper STT
  - 자막 교정
  - 영상 분석
  - EDL 생성
  - preview 렌더
  - 선택적 CapCut
  - final render
- `--source=1 --skip-render` 실검증 결과
  - 전처리 / STT / 자막 교정 / 영상 분석 / EDL 생성 성공
  - `analysis.json`, `edit_decision_list.json`, session temp 산출물 생성 확인
  - scene 중복 감지를 줄이기 위해 EDL builder에 인접 transition merge 보정 추가
  - preview 렌더는 실제로 진행되지만, 현재 실자산에서는 wall-clock이 길어 추가 최적화가 필요
  - single-flight lock 추가로 동시 실행은 즉시 거절되며, 검증 후 lock 해제와 child process 정리까지 확인

### 6. 워커 웹 영상 편집 API + 프론트엔드 ✅
- `bots/video/migrations/002-video-sessions.sql`
  - `video_sessions`, `video_upload_files` 추가
  - `video_edits.session_id`, `pair_index`, `confirm_status`, `reject_reason` 확장
- `bots/worker/web/routes/video-api.js`
  - 세션 생성/업로드/정렬/노트/시작/상태/confirm/reject/preview/subtitle/download/ZIP API 구현
- `bots/video/scripts/run-pipeline.js`
  - `--session-id`, `--pair-index` 지원으로 worker 세션과 `video_edits` 원장을 연결
- `bots/video/scripts/render-from-edl.js`
  - preview 확인 후 confirm 단계에서 final render만 별도로 수행하는 스크립트 추가
- `bots/worker/web/app/video/page.js`, `app/video/history/page.js`
  - 대화형 편집 UI와 과거 세션 이력 화면 추가
- 중요한 운영 경계:
  - worker-web 인증은 localStorage JWT 헤더 기반이라 `<video>`와 `<track>`에 직접 Authorization을 실을 수 없음
  - 그래서 preview/subtitle/download는 `fetch + Authorization + blob URL`로 우회 구현

---

## 다음 세션에서 해야 할 것

### 즉시: 과제 7 운영 안정화
- worker-web 세션 루프는 연결 완료
- 남은 건 실자산 preview wall-clock 최적화와 final render 운영 시간 측정
- FFmpeg `drawtext` / `subtitles` capability 부족 환경에서의 자막 번인 전략 확정
- 필요 시 worker-web에서 세트별 현재 단계/예상시간 표현을 더 세분화

### 이후: 과제 7 → 8 → 9 → 10~12 → 13 순차 진행

---

## 프로젝트 현재 상태

```
ai-agent-system/bots/video/
├─ config/video-config.yaml        ✅ YouTube 확정값 + capcut_api(선택적)
├─ context/IDENTITY.md             ✅
├─ docs/
│   ├─ CLAUDE.md                   ✅ EDL JSON 섹션 + 절대 규칙 13개
│   ├─ SESSION_HANDOFF_VIDEO.md    ✅ 이 파일
│   ├─ VIDEO_HANDOFF.md            ✅ EDL 아키텍처 반영
│   ├─ video-automation-tech-plan.md ✅ (원본 유지)
│   ├─ video-team-design.md        ✅ video-analyzer + edl-builder 반영
│   └─ video-team-tasks.md         ✅ 과제 6, 10~12 재정의 완료
├─ lib/
│   ├─ ffmpeg-preprocess.js        ✅ 과제 2
│   ├─ whisper-client.js           ✅ 과제 3
│   ├─ subtitle-corrector.js       ✅ 과제 4
│   └─ capcut-draft-builder.js     ✅ 과제 5 (선택적 보조)
│   ├─ video-analyzer.js           ✅ 과제 6
│   └─ edl-builder.js              ✅ 과제 6
├─ migrations/001-video-schema.sql ✅
├─ scripts/
│   ├─ test-preprocess.js          ✅
│   ├─ test-whisper.js             ✅
│   ├─ test-subtitle-corrector.js  ✅
│   └─ test-capcut-draft.js        ✅
│   ├─ test-video-analyzer.js      ✅
│   └─ test-edl-builder.js         ✅
│   └─ run-pipeline.js             ✅ 과제 7 1차 통합
├─ src/index.js                    ✅
├─ samples/ (5세트 + ANALYSIS.md)  ✅
└─ temp/ (synced.mp4, SRT 등)      ✅
```

## 진행 현황

```
Week 1: 핵심 파이프라인
  ✅ 과제 1: 프로젝트 스캐폴딩 + DB
  ✅ 과제 2: FFmpeg 전처리
  ✅ 과제 3: Whisper STT
  ✅ 과제 4: LLM 자막 교정
  ✅ 과제 5: CapCutAPI 드래프트 (선택적 보조)
  ✅ 과제 6: 영상 분석 + EDL 생성 + FFmpeg 렌더링
  ☐ 과제 7: 엔드투엔드 파이프라인 통합 (runner 구현 완료, preview 최적화 남음)

Week 2: 워커웹 + n8n + 품질 루프
  ☐ 과제 8: 워커 웹 프리뷰 (프레임 단위 편집 의견)
  ☐ 과제 9: n8n 연동
  ☐ 과제 10: Critic (자막+오디오+★영상 구조)
  ☐ 과제 11: Refiner (SRT+★EDL 생성/수정)
  ☐ 과제 12: Evaluator + 품질 루프
  ☐ 과제 13: 5세트 검증

Week 3: 최종 테스트 + 문서 체계 통합
```

## 핵심 결정사항

```
[확정] YouTube 렌더링: 24Mbps, H.264 High, 48kHz/384kbps, movflags +faststart, BT.709
[확정] 1440p 업로드 = VP9 코덱 트리거
[확정] EDL JSON 기반 아키텍처 (CapCut draft_info.json 의존 폐기)
[확정] RED/BLUE 팀이 자막+오디오+★영상 편집 모두 관여
[확정] 프리뷰: FFmpeg 720p + 워커 웹 HTML5 Video+VTT
[확정] 영상제작팀 프레임 단위 편집 의견 → EDL JSON 수정 → 프리뷰 재생성
[확정] CapCutAPI는 선택적 보조 (--with-capcut, 기본 비활성)
[확정] 저비용 LLM: 자막 gpt-4o-mini, 품질루프 전부 무료 (월 ~$1.12)
[확정] Gemini 2.5-flash (2.0 퇴역)
[확정] Phase 2 연구: CapCutAPI 저장 실패 원인, Remotion SaaS 전환
[확정] 과제 6 smoke 검증: 120초 샘플에서 preview/final 렌더 성공
[확정] 과제 7 1차 통합: `run-pipeline.js`가 source 선택부터 DB status/trace/preview까지 연결
[확정] 과제 7 운영 안전장치: single-flight lock + stale lock 정리 + SIGINT/SIGTERM 시 lock 해제
[주의] 실자산 preview 렌더는 EDL transition 수에 따라 wall-clock이 길 수 있어 추가 최적화가 필요
[주의] 현재 로컬 FFmpeg는 `drawtext`, `subtitles` 필터가 없어 overlay/burn-in은 capability fallback으로 자동 생략됨
```
