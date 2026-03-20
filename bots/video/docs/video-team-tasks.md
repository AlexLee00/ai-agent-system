# 비디오팀 인수인계 — 소과제 분류 + 구현 프롬프트

> 작성일: 2026-03-20
> 전략 담당: 메티 (claude.ai)
> 구현 담당: Claude Code (Sonnet)
> 참조 문서:
>   - CLAUDE.md (구현 규칙 + YouTube 렌더링 확정값)
>   - video-automation-tech-plan.md (기술 구현 방안 전체)
>   - video-team-design.md (설계 + 모듈 매핑 + 기능목록)
>   - ../samples/ANALYSIS.md (샘플 ffprobe 분석 + 출력 스펙 근거)

---

## 소과제 총괄

```
Phase 1 — Week 1: 핵심 파이프라인 (소과제 7개)
Phase 1 — Week 2: 워커웹 + n8n + 품질 루프 (소과제 6개)
Phase 1 — Week 3: 최종 통합 테스트 + 품질 테스트
────────────────────────────────────────────
총 13개 소과제 + 최종 테스트
기존 모듈 15개 재사용, 신규 모듈 10개
```

## ★ 개발 원칙

```
1. 단계적 구현: 한번에 전부 만들지 않는다. 과제 단위로 구현.
2. 단위 테스트 필수: 각 과제 완료 시 반드시 단위 테스트 통과 후 다음 진행.
3. 최종 테스트: 프로토타입 전체 완성 후 통합 테스트 + 품질 테스트 수행.
4. 커밋 규칙: 과제 1개 완료 = 1 커밋 (테스트 포함)
5. 모든 개발 종료 시 관련 문서 업데이트 후 커밋/푸시까지 마감한다.
```

## ★ 역할 경계

```
- Claude:
  bots/video 폴더의 문서를 읽고 구조를 해석하며, 프롬프트/설계 방향을 정리한다.
  코드 직접 수정 주체로 가정하지 않는다.

- 코덱(Codex) / Claude Code:
  실제 파일 생성/수정, 테스트, 문서 업데이트, 커밋/푸시를 수행한다.
```

---

## Phase 1 — Week 1: 핵심 파이프라인

### 과제 1: 프로젝트 스캐폴딩 + DB 스키마

```
목표: bots/video/ 최소 스캐폴딩 + DB 테이블 + config
의존: 없음 (첫 번째 작업)
산출: 디렉토리 구조 + DB 테이블 + config + 기존 기획 MD 파일 유지

작업 위치:
  생성: bots/video/ (최소 스캐폴딩 구조)
  생성: bots/video/migrations/001-video-schema.sql
  생성: bots/video/config/video-config.yaml
  생성: bots/video/context/IDENTITY.md
  생성: bots/video/scripts/ (다른 bots와 동일한 공통 구조 유지)
  수정: .gitignore (*.mp4, *.m4a, dfd_*/ 추가)

  ★ MD 파일 배치:
    bots/video/docs/VIDEO_HANDOFF.md
    bots/video/docs/video-automation-tech-plan.md
    bots/video/docs/video-team-design.md
    bots/video/docs/video-team-tasks.md
    → 개발 중에는 코드 옆에서 관리
    → 최종 테스트 완료 후 docs/ 체계로 이동

기존 모듈 활용:
  packages/core/lib/pg-pool.js — DB 연결 (그대로 사용)

단위 테스트:
  ☐ bots/video/ 구조가 bots/blog/ 패턴과 일치
  ☐ bots/video/docs/ 에 MD 4개 파일 존재
  ☐ psql -d jay -c "SELECT * FROM video_edits LIMIT 1" 에러 없음
  ☐ video-config.yaml 로드 테스트
```

**Claude Code 프롬프트:**
```
bots/video/ 디렉토리를 생성해줘. bots/blog/ 패턴을 참고하되 비디오팀 전용으로.

1. 디렉토리 구조:
   bots/video/
   ├─ docs/                          ← 기획 MD 파일 (개발 중 여기서 관리)
   │   ├─ VIDEO_HANDOFF.md
   │   ├─ video-automation-tech-plan.md
   │   ├─ video-team-design.md
   │   └─ video-team-tasks.md
   ├─ context/IDENTITY.md (비디오 편집 자동화 봇 정체성)
   ├─ lib/ (빈 폴더)
   ├─ config/video-config.yaml
   ├─ migrations/001-video-schema.sql
   ├─ scripts/ (빈 폴더)
   └─ src/index.js (기본 엔트리)

2. docs/ 폴더의 MD 파일 4개는 이미 bots/video/docs/에 배치돼 있으므로 유지하고,
   누락된 경우에만 같은 폴더 기준으로 복원
   (이 파일들은 메티(claude.ai)가 작성한 기획서임)

3. video-config.yaml 내용은 bots/video/docs/video-team-design.md 섹션 5 참조

4. 001-video-schema.sql 내용은 bots/video/docs/video-team-design.md 섹션 4 참조

5. .gitignore에 추가: *.mp4, *.m4a, *.srt, dfd_*/

6. index.js는 config 로드 + pg-pool 연결 테스트만 포함

기존 모듈: packages/core/lib/pg-pool.js 그대로 require해서 사용

★ 문서 위치 원칙:
  개발 중 → bots/video/docs/ (코드 옆에서 함께 관리)
  최종 테스트 후 → docs/video/ 로 이동 (프로젝트 문서 체계 통합)
```

---

### 과제 2: FFmpeg 전처리 모듈

```
목표: 원본 오디오 제거 + 나레이션 LUFS 정규화 + 합성
의존: 과제 1 (디렉토리 구조)
산출: ffmpeg-preprocess.js

작업 위치:
  생성: bots/video/lib/ffmpeg-preprocess.js

기존 모듈 활용:
  packages/core/lib/kst.js — 시간 유틸리티
  packages/core/lib/trace.js — trace_id 추적
  packages/core/lib/tool-logger.js — FFmpeg 호출 로깅

단위 테스트:
  ☐ sources/1/원본_1.mp4 + 원본_나레이션_1.m4a → temp/synced_1.mp4 생성
  ☐ synced_1.mp4 오디오 LUFS가 -14 ± 1 범위
  ☐ synced_1.mp4 영상은 원본과 동일 (재인코딩 없음, -c:v copy)
```

**Claude Code 프롬프트:**
```
bots/video/lib/ffmpeg-preprocess.js를 구현해줘.

기능:
1. removeAudio(inputPath) — 원본 mp4에서 오디오 트랙 제거
   → ffmpeg -i input.mp4 -an -c:v copy output.mp4

2. normalizeAudio(inputPath, config) — m4a 오디오 LUFS 정규화
   → config에서 audio_normalize.target_lufs, true_peak, lra 읽기
   → ffmpeg -i input.m4a -af loudnorm=I=${config.audio_normalize.target_lufs}:TP=${config.audio_normalize.true_peak}:LRA=${config.audio_normalize.lra} output.m4a

3. syncVideoAudio(videoPath, audioPath, outputPath) — 영상+오디오 합성
   → ffmpeg -i audio.m4a -ar 48000 -ac 2 resampled.m4a  (44.1kHz mono → 48kHz stereo)
   → ffmpeg -i video.mp4 -i audio.m4a -c:v copy -c:a aac output.mp4

4. preprocess(sourceDir, tempDir) — 위 3단계를 순차 실행
   → sourceDir에서 원본_*.mp4, 원본_나레이션_*.m4a를 찾아
   → tempDir에 synced.mp4 + narr_norm.m4a 출력

child_process.execFile 사용, Promise 래핑.
에러 시 tool-logger.js로 실패 기록.
config에서 LUFS 값 읽기: const config = require('../config/video-config.yaml')
테스트 스크립트도 scripts/test-preprocess.js로 만들어줘.

참조: video-team-design.md 섹션 3-1
```

---

### 과제 3: Whisper STT 클라이언트

```
목표: Whisper API 호출 → verbose_json → SRT 파일 생성
의존: 과제 1
산출: whisper-client.js

작업 위치:
  생성: bots/video/lib/whisper-client.js

기존 모듈 활용:
  packages/core/lib/llm-keys.js — OpenAI API 키
  packages/core/lib/llm-logger.js — Whisper 비용 추적
  packages/core/lib/tool-logger.js — API 호출 로깅

단위 테스트:
  ☐ sources/1/원본_나레이션_1.m4a → temp/subtitle_raw_1.srt 생성
  ☐ SRT 형식 유효 (번호 + 타임스탬프 + 텍스트)
  ☐ llm_usage_log에 Whisper 비용 기록됨
```

**Claude Code 프롬프트:**
```
bots/video/lib/whisper-client.js를 구현해줘.

기능:
1. transcribe(audioPath, language='ko') — Whisper API 호출
   → OpenAI Whisper API (model: whisper-1)
   → response_format: verbose_json (word-level timestamps)
   → 결과: { text, segments: [{ start, end, text }] }

2. toSRT(segments) — segments 배열 → SRT 형식 문자열 변환
   → "1\n00:00:01,000 --> 00:00:03,500\n안녕하세요\n\n"

3. generateSubtitle(audioPath, outputSrtPath) — 1+2 통합
   → audioPath에서 STT → SRT 파일로 저장

OpenAI API 호출:
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioPath));
  formData.append('model', 'whisper-1');
  formData.append('language', 'ko');
  formData.append('response_format', 'verbose_json');
  
  fetch('https://api.openai.com/v1/audio/transcriptions', {
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData
  })

API 키: packages/core/lib/llm-keys.js에서 가져오기
비용 로깅: llm-logger.js logLLMCall() 사용 (provider='openai', model='whisper-1')
오디오 길이(분) × $0.006 = 비용

참조: video-automation-tech-plan.md 섹션 4-2
```

---

### 과제 4: LLM 자막 교정

```
목표: SRT 텍스트를 LLM 셀렉터로 교정 (IT 전문용어 + 오탈자)
의존: 과제 3 (SRT 파일)
산출: subtitle-corrector.js

작업 위치:
  생성: bots/video/lib/subtitle-corrector.js

기존 모듈 활용:
  packages/core/lib/llm-router.js — 복잡도 기반 라우팅
  packages/core/lib/llm-fallback.js — 폴백 체인
  packages/core/lib/llm-logger.js — 교정 비용 추적

단위 테스트:
  ☐ subtitle_raw.srt → subtitle_corrected.srt 생성
  ☐ 타임스탬프 변경 없음 (before/after diff로 확인)
  ☐ IT 용어 (FlutterFlow, Firebase 등) 정확하게 교정됨
  ☐ 폴백 테스트: OpenAI 키 비활성화 → Gemini로 자동 전환
```

**Claude Code 프롬프트:**
```
bots/video/lib/subtitle-corrector.js를 구현해줘.

기능:
1. correctSubtitle(srtText, config) — SRT 텍스트 전체를 LLM으로 교정
   → config에서 llm_provider, llm_model 읽기
   → 시스템 프롬프트: 
     "FlutterFlow, Firebase, Supabase, Dart, Widget 등 IT 전문용어에 
      익숙한 한국어 자막 교정 전문가. 오탈자, 띄어쓰기, 기술 용어 오류를 수정.
      타임스탬프(00:01:23,456 형식)는 절대 수정하지 않는다.
      교정된 SRT 형식 그대로 출력한다."
   → 입력: SRT 텍스트 전체
   → 출력: 교정된 SRT 텍스트

2. correctFile(inputSrtPath, outputSrtPath) — 파일 기반 래퍼

LLM 호출은 기존 팀 제이 패턴 사용:
  const { callLLM } = require('../../packages/core/lib/llm-router');
  또는 llm-fallback.js의 callWithFallback() 사용

폴백 순서: config의 provider → fallback_provider → 원본 SRT 유지
실패 시 텔레그램 알림 (telegram-sender.js)

참조: video-automation-tech-plan.md 섹션 4-3
```

---

### 과제 5: CapCutAPI 드래프트 생성

```
목표: CapCutAPI MCP 연동 → 드래프트 자동 생성 → CapCut 디렉토리 복사
의존: 과제 2, 3, 4 (전처리 결과물)
산출: capcut-draft-builder.js

작업 위치:
  생성: bots/video/lib/capcut-draft-builder.js

외부 의존:
  CapCutAPI (localhost:9001) — 별도 프로세스로 구동 필요

단위 테스트:
  ☐ CapCutAPI 서버 연결 테스트 (health check)
  ☐ create_draft → add_video → add_audio → add_subtitle → save_draft 성공
  ☐ dfd_ 폴더가 CapCut 드래프트 디렉토리에 복사됨
  ☐ CapCut Desktop에서 드래프트 열림 확인 (수동)
```

**Claude Code 프롬프트:**
```
bots/video/lib/capcut-draft-builder.js를 구현해줘.

기능:
1. healthCheck() — CapCutAPI 서버 상태 확인
   → GET http://localhost:9001/health (또는 적절한 엔드포인트)

2. createDraft(projectName) — 새 프로젝트 생성
   → POST http://localhost:9001/create_draft { name: projectName }

3. addVideo(draftId, videoPath, start, end) — 비디오 트랙 추가
   → POST http://localhost:9001/add_video { video_url, start, end }

4. addAudio(draftId, audioPath, volume) — 오디오 트랙 추가
   → POST http://localhost:9001/add_audio { audio_url, volume }

5. addSubtitle(draftId, srtPath) — 자막 추가
   → POST http://localhost:9001/add_subtitle { subtitle_file }

6. saveDraft(draftId) — 드래프트 저장 → dfd_ 폴더 생성

7. copyToCapCut(dfdPath, capCutDir) — dfd_ 폴더를 CapCut 디렉토리에 복사
   → fs.cpSync(dfdPath, path.join(capCutDir, dfdName), { recursive: true })

8. buildDraft(syncedVideoPath, normalizedAudioPath, correctedSrtPath, title)
   → 위 1~7을 순차 실행하는 통합 함수

config에서 capcut_api.host, paths.capcut_drafts 읽기
모든 HTTP 호출에 에러 핸들링 + tool-logger.js 로깅

참조: video-automation-tech-plan.md 섹션 4-4
```

---

### 과제 6: 영상 분석 + EDL 생성 + FFmpeg 렌더링

```
목표: FFmpeg 영상 분석 + EDL JSON 생성 → 프리뷰(720p) + 최종 렌더링(1440p/60fps)
의존: 과제 5 (드래프트 생성 완료)
산출: video-analyzer.js + edl-builder.js

작업 위치:
  생성: bots/video/lib/video-analyzer.js
  생성: bots/video/lib/edl-builder.js

단위 테스트:
  ☐ video-analyzer가 무음/정지/씬전환 후보를 JSON으로 생성
  ☐ EDL JSON이 생성됨
  ☐ 프리뷰(720p) 명령어가 올바르게 생성됨
  ☐ 최종 렌더링 명령어가 올바르게 생성됨
  ☐ exports/편집_1.mp4 = 2560×1440, H.264 High Profile, 60fps, ~24Mbps
  ☐ ffprobe로 movflags faststart 확인
  ☐ 오디오: AAC 48kHz stereo 384kbps
  ☐ 자막이 영상에 번인됨
```

**Claude Code 프롬프트:**
```
bots/video/lib/video-analyzer.js + edl-builder.js를 구현해줘.

[video-analyzer.js]
FFmpeg 기반으로 영상 구조를 분석해서 편집 후보를 추출.

기능:
1. analyzeVideo(videoPath, config) → { silences: [], freezes: [], scenes: [] }
   - ffmpeg silencedetect
   - ffmpeg freezedetect
   - ffmpeg scene 감지
   - 결과를 analysis.json으로 저장 가능하도록 구조화

[edl-builder.js]
영상 분석 + critic 리포트를 바탕으로 EDL JSON 생성/수정 + FFmpeg 렌더링.

기능:
1. buildInitialEDL(sourcePath, subtitlePath, analysis, options) → edit_decision_list.json
   - 컷, 속도, 전환, 텍스트 오버레이를 JSON으로 표현
   - EDL 구조는 CLAUDE.md의 'EDL JSON' 섹션 참조

2. buildPreviewCommand(edl, outputPath, config) → FFmpeg 명령어 문자열
   - 720p 빠른 프리뷰
   - 자막 번인
   - EDL의 cut / transition / speed / text_overlay 반영

3. buildFinalRenderCommand(edl, outputPath, config) → FFmpeg 명령어 문자열
   - 2560x1440, 60fps, H.264 High Profile, 24Mbps
   - AAC 48kHz stereo 384kbps

4. renderPreview(edl, outputPath, config) → FFmpeg 실행
5. renderFinal(edl, outputPath, config) → FFmpeg 실행
   - child_process.execFile 사용
   - 진행률 파싱 (FFmpeg stderr에서 time= 추출)
   - 완료 시 tool-logger.js로 렌더링 시간 기록

구현 규칙:
- CapCut draft_info.json 의존 금지
- config/video-config.yaml 기준값 사용
- EDL JSON을 진실 원장으로 사용
- 프리뷰는 720p, 최종본은 1440p/24Mbps
```

---

### 과제 7: 엔드투엔드 파이프라인 통합

```
목표: 과제 2~6을 하나의 파이프라인으로 연결 + 텔레그램 알림
의존: 과제 2, 3, 4, 5, 6
산출: src/index.js 통합, scripts/run-pipeline.js

작업 위치:
  수정: bots/video/src/index.js
  생성: bots/video/scripts/run-pipeline.js

기존 모듈 활용:
  telegram-sender.js, pg-pool.js, trace.js, llm-logger.js

단위 테스트:
  ☐ node scripts/run-pipeline.js --source=1 실행
  ☐ sources/1/ → 전처리 → STT → 교정 → 분석 → EDL → 프리뷰 → 렌더링 완료
  ☐ video_edits 테이블에 이력 기록됨
  ☐ 텔레그램에 알림 수신됨
  ☐ exports/편집_DB생성.mp4 파일 존재
```

**Claude Code 프롬프트:**
```
bots/video/src/index.js와 scripts/run-pipeline.js를 구현해줘.

[run-pipeline.js]
CLI에서 수동으로 파이프라인 실행하는 스크립트.
Usage: node scripts/run-pipeline.js --source=1 [--skip-render]

흐름:
1. config 로드 (video-config.yaml)
2. trace_id 시작 (packages/core/lib/trace.js startTrace)
3. 전처리 (ffmpeg-preprocess.js preprocess)
4. STT (whisper-client.js generateSubtitle)
5. 자막 교정 (subtitle-corrector.js correctFile)
6. FFmpeg 영상 분석 (video-analyzer.js analyzeVideo)
7. EDL 생성 + 프리뷰 렌더링 (edl-builder.js)
8. 마스터 OK 대기 (--skip-render 옵션 시 여기서 종료)
9. 필요 시 선택적 CapCut 프리뷰 생성 (--with-capcut 옵션일 때만)
10. FFmpeg 최종 렌더링 (edl-builder.js renderFinal)
11. video_edits 테이블에 이력 저장 (pg-pool.js)
12. 텔레그램 알림: "렌더링 완료 → 유튜브 업로드 준비됨"

각 단계에서:
- 시작/종료 시간 기록 (preprocess_ms, stt_ms 등)
- 에러 시 status='failed' + error_message 저장
- trace_id로 전체 파이프라인 추적

[src/index.js]
메인 엔트리. 현재는 run-pipeline.js를 모듈로 export.
n8n 연동은 Phase 1 Week 2에서 추가.

참조: video-team-design.md 섹션 2 (디렉토리 구조)
```

---

## Phase 1 — Week 2: n8n 통합 + 품질 루프 + 워커 웹

### 과제 8: 워커 웹 대화형 영상 편집 페이지

```
목표: 대화형 UX로 업로드 → 편집 → 컨펌 → 다운로드 전 과정 웹에서 완결
의존: 과제 7 (파이프라인 완성)
산출: API 라우트 + React 대화형 페이지 + DB 마이그레이션

★ 핵심: 클로드 프롬프트처럼 절차 안내 + 편집 의도 수집 + 다음 작업 안내
  "다음은 ○○○ 작업입니다." 형태로 매 단계 가이드

작업 위치:
  생성: apps/worker-web/routes/video.js
  생성: apps/worker-web/client/pages/VideoEditorPage.js (대화형 메인)
  생성: apps/worker-web/client/pages/VideoHistoryPage.js (이력)
  생성: 마이그레이션 — video_sessions + video_upload_files 테이블
  수정: Sidebar.js ("📹 영상 편집" 메뉴 추가)

기존 모듈 활용:
  multer (다중 파일), JWT, company_id, audit_log, enabled_menus, PWA

단위 테스트:
  ☐ 다중 파일 업로드 (mp4 3개 + m4a 3개) 성공
  ☐ 파일 순서 변경 API 동작
  ☐ 편집 의도(edit_notes) 저장/수정
  ☐ 세션 상태 머신 전환 (uploading→processing→draft_ready→...)
  ☐ RAG 예상 시간 API (과거 데이터 0건/3건 케이스)
  ☐ 세트별 컨펌/재편집 요청 API
  ☐ 최종본 다운로드 (개별 + ZIP)
  ☐ 대화형 UI에서 9단계 시나리오 통과 (수동 테스트)
```

**Claude Code 프롬프트:**
```
워커 웹에 대화형 영상 편집 페이지를 구현해줘.

★ 핵심 UX: 클로드 프롬프트처럼 절차 안내 + 편집 의도 수집
  각 단계마다 "다음은 ○○○ 작업입니다."로 안내

참조: video-team-design.md 섹션 7 (대화형 UX 시나리오 9단계)

[DB — 마이그레이션]
video_sessions: 세션 관리 (1건의 편집 요청)
  id, company_id, uploaded_by, title, edit_notes, 
  estimated_time_ms, total_cost, status, created_at

video_upload_files: 업로드 파일 (다중, 순서)
  id, session_id, file_type, original_name, stored_name,
  file_size_mb, sort_order, pair_index, created_at

video_edits 확장: + session_id, pair_index, confirm_status,
  reject_reason, download_path, download_count

[백엔드 — routes/video.js]
API는 video-team-design.md 섹션 7-5 참조 (세션/업로드/편집/다운로드)

핵심 API:
- POST /api/video/sessions — 세션 생성
- POST /api/video/sessions/:id/upload — 다중 파일 업로드 (multer)
  mp4 여러 개 + m4a 여러 개, sort_order로 순서 관리
- PUT /api/video/sessions/:id/notes — 편집 의도 저장
- POST /api/video/sessions/:id/start — 편집 시작 트리거
- GET /api/video/sessions/:id/status — 실시간 상태 (5초 폴링)
  각 세트별 단계별 진행 상태 반환
- GET /api/video/estimate — RAG 기반 예상 시간
  video_edits 과거 이력에서 유사 조건 검색 → 평균 시간
- POST /api/video/edits/:id/confirm — 세트별 컨펌
- POST /api/video/edits/:id/reject — 재편집 (사유 포함)
- GET /api/video/edits/:id/download — 최종본 다운로드
- GET /api/video/sessions/:id/download-all — ZIP 다운로드

[프론트엔드 — VideoEditorPage.js]
대화형 채팅 UI:
- messages 배열로 시스템 메시지 + 사용자 입력 관리
- 상태 머신: idle → uploading → uploaded → processing →
  draft_ready → confirming → rendering → done
- 각 상태 전환 시 시스템 메시지 자동 추가

UI 구성요소:
- 메시지 영역 (채팅 버블 형태, 시스템=왼쪽, 사용자=오른쪽)
- 다중 파일 업로드 (드래그앤드롭, 순서 변경, 영상-음성 매칭 표시)
- 편집 의도 입력란 (선택사항)
- 진행 상태 (세트별 단계별 + 경과시간 + RAG 예상시간)
- 컨펌/재편집 버튼 (세트별)
- 다운로드 버튼 (개별 + 전체 ZIP)

기존 코드 참고:
  - 문서 업로드: apps/worker-web/routes/ 에서 multer 패턴
  - 인사/매출 목록: 기존 페이지 레이아웃 패턴
  - 보안: middleware/ 인증+보안 패턴
```

---

### 과제 9: n8n 워크플로우 연동

```
목표: 웹 업로드 → n8n 웹훅 → 파이프라인 자동 트리거
의존: 과제 7, 8
산출: n8n 워크플로우 JSON + 웹훅 연동

작업 위치:
  수정: bots/video/src/index.js (n8n 웹훅 수신 추가)
  생성: bots/video/n8n/video-pipeline.json (n8n 워크플로우)

기존 모듈: n8n-runner.js, n8n-webhook-registry.js

단위 테스트:
  ☐ n8n 웹훅 호출 → 파이프라인 시작됨
  ☐ 파이프라인 상태가 video_sessions에 실시간 업데이트됨
  ☐ 에러 시 n8n에서 재시도 동작
```

### 과제 10: Critic Agent (RED Team)

```
목표: 드래프트 분석 → 문제점 리포트 JSON 생성
의존: 과제 5 (드래프트 존재)
산출: critic-agent.js

작업 위치: bots/video/lib/critic-agent.js
기존 모듈: llm-router.js
참조: video-automation-tech-plan.md 섹션 6-3

단위 테스트:
  ☐ 정상 드래프트 → 리포트 JSON 생성 (issues 배열 + scores 객체)
  ☐ 자막 싱크 오류 감지 (±200ms 초과 시)
  ☐ 오디오 LUFS 범위 이탈 감지
  ☐ overall_score 85 미만 시 pass=false
```

### 과제 11: Refiner Agent (BLUE Team)

```
목표: Critic 리포트 기반 드래프트 자동 수정
의존: 과제 10
산출: refiner-agent.js

작업 위치: bots/video/lib/refiner-agent.js
기존 모듈: subtitle-corrector.js, capcut-draft-builder.js
참조: video-automation-tech-plan.md 섹션 6-4

단위 테스트:
  ☐ 자막 타이밍 오류 리포트 → SRT 수정 + 드래프트 업데이트
  ☐ 오디오 밸런스 리포트 → 재정규화 + 드래프트 업데이트
  ☐ 수정 후 드래프트 버전 V2 생성 확인
```

### 과제 12: Evaluator Agent + 품질 루프

```
목표: 품질 점수 판정 + 루프 오케스트레이션
의존: 과제 10, 11
산출: evaluator-agent.js, quality-loop.js

작업 위치: bots/video/lib/evaluator-agent.js, quality-loop.js
참조: video-automation-tech-plan.md 섹션 6-5, 6-2

단위 테스트:
  ☐ 85점 이상 → PASS (루프 종료)
  ☐ 85점 미만 → FAIL → Critic 재실행 확인
  ☐ 3회 반복 후 미달 → 최고 점수 버전으로 전달 + 알림
  ☐ 루프별 LLM 비용 누적 계산 정확성
```

### 과제 13: 나머지 4세트 검증

```
목표: sources/2~5 전체 파이프라인 통과 검증
의존: 과제 7~12
산출: 테스트 결과 리포트

단위 테스트:
  ☐ 5세트 모두 파이프라인 성공
  ☐ 평균 처리 시간 기록
  ☐ 비용 합계 확인 (월 $1 미만)
  ☐ 품질 점수 분포 확인
```

---

## Phase 1 — Week 3: 최종 통합 테스트 + 품질 테스트

### 통합 테스트

```
목표: 전체 프로토타입 엔드투엔드 동작 검증
전제: 과제 1~13 모두 완료 + 개별 단위 테스트 통과

시나리오 1: 단일 세트 (기본)
  ☐ 웹 업로드 (mp4 1개 + m4a 1개) → 편집 → 컨펌 → 렌더링 → 다운로드
  ☐ 전 과정 대화형 UI에서 9단계 시나리오 통과
  ☐ video_sessions + video_edits 테이블 정합성

시나리오 2: 다중 세트 (3세트)
  ☐ 웹 업로드 (mp4 3개 + m4a 3개) → 순차 편집 → 세트별 컨펌 → 렌더링
  ☐ 세트 1만 재편집 요청 → 나머지 2개는 렌더링 진행
  ☐ 전체 ZIP 다운로드

시나리오 3: 에러 핸들링
  ☐ Whisper API 실패 → 에러 메시지 + 재시도 안내
  ☐ CapCutAPI 미구동 → 에러 메시지 + 수동 처리 안내
  ☐ 잘못된 파일 형식 업로드 → 화이트리스트 거부 메시지

시나리오 4: 보안
  ☐ 다른 업체(company_id) 세션 접근 불가
  ☐ 비인증 상태 API 호출 거부
  ☐ audit_log에 전 과정 기록됨
```

### 품질 테스트

```
목표: 자동 편집 결과물의 품질 검증

품질 항목:
  ☐ 자막 정확도: 원본 나레이션 대비 자막 일치율 90% 이상
  ☐ 자막 타이밍: ±300ms 이내 정확도
  ☐ IT 전문용어: FlutterFlow, Firebase 등 정확 표기
  ☐ 오디오 레벨: -14 LUFS ± 1 범위
  ☐ 영상 품질: 2560×1440, 60fps, H.264
  ☐ 파일 크기: YouTube 권장 비트레이트 (24Mbps 근처)

비교 테스트:
  ☐ 자동 편집본 vs 기존 수동 편집본 비교 (5세트)
  ☐ 처리 시간 비교 (자동 vs 수동)
  ☐ 비용 합산 (목표: 월 $1 미만)

결과 문서:
  → docs/video-test-results.md에 결과 기록
  → 미달 항목은 docs/KNOWN_ISSUES.md에 등록
```

**Claude Code 프롬프트:**
```
비디오팀 최종 통합 테스트 + 품질 테스트를 실행해줘.

1. 통합 테스트 4개 시나리오 순차 실행
   - 시나리오 1: 단일 세트 엔드투엔드
   - 시나리오 2: 다중 세트 3개 + 재편집 1건
   - 시나리오 3: 에러 핸들링 (API 실패, 잘못된 파일)
   - 시나리오 4: 보안 (company_id 격리, 인증)

2. 품질 테스트
   - sources/1~5 자동 편집 결과물 품질 검증
   - 자막 정확도, 타이밍, 오디오 레벨, 영상 품질
   - 기존 수동 편집본과 비교

3. 결과를 docs/video-test-results.md에 기록
   - 통과/실패 항목, 수치, 스크린샷
   - 미달 항목 → docs/KNOWN_ISSUES.md 등록

4. 테스트 스크립트: scripts/test-integration.js
```

---

## 실행 순서 요약

```
Week 1: 핵심 파이프라인 (각 과제 완료 시 단위 테스트 필수)
  Day 1: 과제 1 (스캐폴딩) → 테스트 → 과제 2 (FFmpeg) → 테스트
  Day 2: 과제 3 (Whisper) → 테스트 → 과제 4 (LLM 교정) → 테스트
  Day 3: 과제 5 (CapCut) → 테스트 → 과제 6 (파서+렌더링) → 테스트
  Day 4-5: 과제 7 (통합) → 테스트 → 폴더 1 엔드투엔드 검증

Week 2: 워커웹 + n8n + 품질 루프
  Day 1-2: 과제 8 (워커 웹 대화형) → 테스트
  Day 3: 과제 9 (n8n) → 테스트
  Day 4: 과제 10~12 (품질 루프) → 테스트
  Day 5: 과제 13 (4세트 검증)

Week 3: 최종 테스트 + 문서 체계 통합
  Day 1-2: 통합 테스트 4개 시나리오
  Day 3: 품질 테스트 (5세트 비교)
  Day 4: 미달 항목 수정
  Day 5: ★ 문서 체계 통합 + 최종 확인
    bots/video/docs/*.md → docs/video/*.md 이동
    VIDEO_HANDOFF.md → docs/VIDEO_HANDOFF.md 승격
    테스트 결과 → docs/video-test-results.md
    최종 문서 정리
```
