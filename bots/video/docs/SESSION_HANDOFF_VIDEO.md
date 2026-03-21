# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-21 (4차 세션)
> 담당: 메티 (claude.ai Opus)
> 상태: 과제 1~12 + RAG 피드백 루프 구현 완료 + worker-web 영상 편집 API/UI 연결 완료 + n8n 연동 live 검증 완료 + 5세트 preview 검증 완료

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

### 7. 과제 10: Critic Agent (RED Team) ✅
- `bots/video/lib/critic-agent.js`
  - `runCritic`, `analyzeSubtitles`, `analyzeAudio`, `analyzeVideoStructure`, `calculateOverallScore`, `parseSrt`, `saveCriticReport` 구현
  - 자막은 Gemini `gemini-2.5-flash` 우선, OpenAI `gpt-4o-mini` fallback
  - 오디오는 FFmpeg `loudnorm=print_format=json`으로 LUFS / True Peak 측정
  - 영상 구조는 `analysis.json`을 재사용해 무음/정지/씬전환/비효율 비율 분석
- `bots/video/scripts/test-critic-agent.js`
  - 실제 테스트 결과:
    - `score=78`, `pass=false`
    - `subtitle issues=18`
    - `audio LUFS=-14.96`, `Peak=-3.54`
    - `scene issues=10`
    - `temp/critic_report.json` 생성
- 운영 보강:
  - LLM 호출 timeout 추가
  - config provider 준수
  - 자막 JSON 파싱 실패 강등
  - 인접 scene 병합
  - 부분 실패 시 해당 분석만 `score=50`, issues 빈 배열로 degrade

### 8. 과제 11: Refiner Agent (BLUE Team) ✅
- `bots/video/lib/refiner-agent.js`
  - `runRefiner`, `refineSubtitles`, `refineEDL`, `refineAudio`, `saveRefinerResult` 구현
  - Critic 리포트를 읽어 자막/SRT, EDL, 오디오를 순차 보정하는 BLUE Team 레이어 추가
  - 자막은 deterministic 치환/타임스탬프 이동/줄 분할을 우선 적용하고, 필요한 경우만 Groq→Gemini LLM 폴백
  - EDL은 `applyPatch()`를 이용해 cut/transition 추가 또는 transition 제거를 처리
- `bots/video/scripts/test-refiner-agent.js`
  - 실제 테스트 결과:
    - `subtitle changes=12`
    - `edl changes=0`
    - `audio=null`
    - `cost_usd=0`
    - `temp/subtitle_corrected_v2.srt`, `temp/refiner_result.json` 생성
  - 수정된 SRT 재파싱(`67 entries`)과 수정된 EDL 재로드 확인
  - 코드 점검 후 `runRefiner()` 단계별 fallback 추가
    - 자막/EDL/오디오 중 하나가 실패해도 전체 Refiner는 중단되지 않음

### 9. 과제 12: Evaluator Agent + quality loop ✅
- `bots/video/lib/evaluator-agent.js`
  - `runEvaluator`, `evaluate`, `compareReports`, `makeRecommendation`, `saveEvaluation` 구현
  - Evaluator 자체적으로 별도 LLM을 호출하지 않고, Refiner 수정본을 기준으로 Critic을 재호출해 점수를 재평가
  - 필요 시 수정된 EDL과 오디오 경로를 반영해 남은 이슈와 오디오 점수를 보정
  - 코드 점검 후 standalone `refiner_result.json`에서도 sibling `analysis.json`을 자동 추론해 재평가할 수 있도록 입력 경계 보강
- `bots/video/lib/quality-loop.js`
  - `runQualityLoop`, `findBestVersion`, `saveLoopResult` 구현
  - `critic -> refiner -> evaluator` 반복과 최고 점수 버전 선택, `PASS / RETRY / ACCEPT_BEST` 종료 판정 추가
  - 각 반복의 산출물을 `critic_report_v0.json`, `refiner_result_v1.json`, `evaluation_v1.json`처럼 temp 원장에 저장
- `bots/video/scripts/test-quality-loop.js`
  - 실제 quality loop 실행, `onProgress` 이벤트 출력, `loop_result.json` 저장 검증
- 실제 테스트 결과:
  - `iteration0 score=80`
  - `iteration1 score=80`
  - `recommendation=ACCEPT_BEST`
  - `final_score=80`, `pass=false`
  - 현재 샘플에서는 Refiner가 추가 변경을 만들지 못해 최고 버전이 원본 subtitle/EDL로 유지됨

### 10. 과제 9: 비디오팀 n8n 연동 ✅
- `bots/video/n8n/video-pipeline-workflow.json`
  - `Video Pipeline` 워크플로우 템플릿 추가
  - 현재 n8n 런타임에서 `ExecuteCommand` activation이 실패해, `Webhook -> 요청 파싱 -> 토큰 확인 -> health probe -> HTTP Request -> Respond` 구조로 호환 전환
  - n8n은 트리거 역할만 맡고, 실제 프로세스 실행은 worker 내부 dispatch API가 기존 detached `fork()` 경로를 재사용
- `bots/video/n8n/setup-video-workflow.js`
  - 공용 `n8n-setup-client` 기반 안전 재생성/활성화 스크립트 추가
  - `VIDEO_N8N_TOKEN` placeholder hydration 후 webhook URL 출력
- `bots/video/n8n/setup-video-workflow.js`
  - registry DB 조회가 실패해도 setup 완료 후 기본 webhook 경로를 출력하도록 보강
  - 즉 workflow 생성/활성화는 성공했는데 URL 출력 단계 때문에 전체 setup이 실패로 끝나는 경계를 제거
- `bots/video/lib/video-n8n-config.js`
  - `VIDEO_N8N_TOKEN`을 env 우선, 없으면 `bots/worker/secrets.json`의 `video_n8n_token` fallback으로 읽도록 통합
- `bots/video/scripts/check-n8n-video-path.js`
  - registry resolved URL + default URL + healthz + webhook registration 진단 스크립트 추가
  - DB 접근이 막힌 컨텍스트에서도 default webhook 경로로 degrade 하도록 보강
- `bots/worker/web/routes/video-internal-api.js`
  - `/api/video/internal/run-pipeline`
  - `/api/video/internal/render-from-edl`
  - `X-Video-Token`으로 보호되는 내부 dispatch API 추가
- `bots/worker/web/routes/video-api.js`
  - `POST /sessions/:id/start`, `POST /edits/:id/confirm`이 `runWithN8nFallback()`를 사용하도록 전환
  - n8n health/webhook 실패 시 기존 detached `fork()` direct fallback 유지
- `packages/core/lib/n8n-runner.js`
  - 커스텀 헤더 전달 지원 추가 (`X-Video-Token`)
- 현재 진단 결과:
  - sandbox 내부 Node `fetch`로는 `healthz`가 막히지만, sandbox 밖 live 검증에서는 정상 동작
  - 임시 `VIDEO_N8N_TOKEN` + worker 재기동 후 `check-n8n-video-path.js` 기준:
    - `n8nHealthy=true`
    - `webhookRegistered=true`
    - `webhookStatus=200`
    - `resolvedWebhookUrl=http://127.0.0.1:5678/webhook/eJrK6wh4S8qAkuw9/webhook/video-pipeline`
  - 이후 실제 운영 `bots/worker/secrets.json`에 `video_n8n_token`을 반영했고, env 없이도 `setup-video-workflow.js` / `check-n8n-video-path.js`가 정상 동작하는 것까지 확인

### 11. RAG 피드백 루프 구현 ✅
- `packages/core/lib/rag.js`
  - `rag_video` 컬렉션 추가
- `bots/video/lib/video-rag.js`
  - 편집 결과/피드백 저장, 유사 편집 검색, 패턴 검색, Critic/EDL 보강, 시간 추정 구현
- `bots/video/scripts/test-video-rag.js`
  - `rag_video` 초기화
  - `storeEditResult()`, `storeEditFeedback()`, `searchSimilarEdits()`, `searchEditPatterns()`
  - `estimateWithRAG()`, `enhanceCriticWithRAG()`, `enhanceEDLWithRAG()` 검증
- 기존 연동
  - `run-pipeline.js`: preview_ready/completed 시 편집 결과 저장
  - `critic-agent.js`: 점수 산출 후 RAG 인사이트 병합
  - `edl-builder.js`: 초기 EDL 생성 후 과거 성공 패턴 반영
  - `worker/web/routes/video-api.js`: confirm/reject 피드백 저장 + `/estimate` RAG 우선 추정
- 실측 결과
  - `storeEditResult: { ragId: '1', stored: true }`
  - `storeEditFeedback: { ragId: '2', stored: true }`
  - `searchSimilarEdits: 2건`
  - `estimateWithRAG.estimated_ms: 180000`
  - `enhanceCriticWithRAG.rag_insights`, `enhanceEDLWithRAG.rag_source` 생성 확인

### 12. 과제 13: 5세트 전체 파이프라인 검증 (`--skip-render`) ✅
- `bots/video/scripts/run-pipeline.js`를 5세트 샘플에 대해 순차 재실행
  - 파라미터
  - 컴포넌트스테이트
  - 동적데이터
  - 서버인증
  - DB생성
- 최초 5세트 실패에서 확인한 핵심 원인:
  - preview watchdog 자체가 아니라 `ffmpeg-preprocess.syncVideoAudio()`가 나레이션 길이에 맞춰 영상을 자르지 않아
    `synced.mp4`의 video/audio duration이 크게 어긋났던 것
- 복구:
  - `syncVideoAudio()`에 audio duration 기준 `-t` + `-shortest` 적용
  - `subtitle.vtt` 생성 시점을 preview 렌더 전에 이동
  - `renderPreview` watchdog을 예상 duration 기준으로 동적 계산
- 최신 재검증 결과:
  - 5세트 모두 `preview_ready`
  - `subtitle.vtt` 5세트 모두 생성
  - `validation_report.json` 기준 `successful=5`, `failed=0`, `avg_total_ms=440378`
  - `rag_video` 적재 건수 `7`, `estimateWithRAG.sample_count=5`, `confidence=high`
- 세트 1 quality loop 재실행 결과:
  - 최신 성공 run 기준 `final_score=80`, `pass=false`, `recommendation=ACCEPT_BEST`
  - RAG 네트워크 우회 모드가 들어가면 quality loop 점수 개선이 제한될 수 있음

---

## 다음 세션에서 해야 할 것

### 즉시: preview 원장 고도화 + final render 다세트 검증
- worker-web 세션 루프는 연결 완료
- 남은 건 `preview_ms`를 DB 원장에 별도 기록하는 구조와 final render 운영 시간 측정
- FFmpeg `drawtext` / `subtitles` capability 부족 환경에서의 자막 번인 전략 확정
- 필요 시 worker-web에서 세트별 현재 단계/예상시간 표현을 더 세분화
- 과제 13의 preview 검증은 완료됐고, 다음은 4~5세트 기준 final render와 quality loop 수렴 패턴까지 함께 검증하면 된다
- n8n 쪽은 live webhook 등록, 내부 dispatch route 검증, worker secret 영속화까지 완료됐고, 다음은 과제 13 다세트 검증으로 넘어가면 된다
- RAG는 이제 편집 결과/피드백을 축적하기 시작했으므로, 다음 검증에서는 세트 수를 늘려 실제 추천 품질과 추정 정확도가 올라가는지 함께 봐야 한다

### 이후: 과제 7 → 8 → 9 → 12 → 13 순차 진행

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
  ✅ 과제 7: 엔드투엔드 파이프라인 통합 1차 (5세트 preview 검증 완료)

Week 2: 워커웹 + n8n + 품질 루프
  ✅ 과제 8: 워커 웹 프리뷰 (프레임 단위 편집 의견)
  ✅ 과제 9: n8n 연동
  ✅ 과제 10: Critic (자막+오디오+★영상 구조)
  ✅ 과제 11: Refiner (SRT+★EDL 생성/수정)
  ✅ 과제 12: Evaluator + 품질 루프
  ✅ 과제 13: 5세트 preview 검증 (`--skip-render`)

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
[확정] 실자산 preview 실패의 핵심 원인은 watchdog이 아니라 `synced.mp4` video/audio duration 불일치였고, preprocessing 수정 후 5세트 모두 `preview_ready` 복구
[주의] `preview_ms`는 아직 DB 원장에 별도 저장되지 않아 validation_report에서는 null로 유지됨
[주의] 현재 로컬 FFmpeg는 `drawtext`, `subtitles` 필터가 없어 overlay/burn-in은 capability fallback으로 자동 생략됨
```
