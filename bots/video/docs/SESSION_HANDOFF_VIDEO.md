# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-20 (3차 세션)
> 담당: 메티 (claude.ai Opus)
> 상태: 과제 1~5 완료, CapCut Desktop 연동 확인 완료, 과제 6부터 이어서 진행

---

## 이번 세션에서 완료한 것

### 1. 영상 샘플 폴더 생성 + 5세트 데이터 배치
- samples/raw/ (원본 5세트), narration/ (나레이션 5세트), edited/ (편집본 5+18개)
- .gitignore + README.md 생성

### 2. ffprobe 전체 분석 + YouTube 공식 권장 사양 리서치
- 5세트 ffprobe 분석 (해상도, fps, 비트레이트, 오디오)
- 5세트 LUFS 분석 (평균 -14.33, True Peak 클리핑 발견)
- YouTube 공식 권장 사양 확인 → 기존 3Mbps가 권장 24Mbps의 12%
- VP9 코덱 트리거 전략 확인 (1440p 업로드 → VP9 강제)
- samples/ANALYSIS.md 작성 (190줄, 초기분석 + YouTube 최종 확정값)

### 3. CLAUDE.md 생성 + 전체 문서 일관성 통일
- bots/video/docs/CLAUDE.md 생성 (96줄, 규칙 + YouTube 확정값)
- video-team-design.md config 업데이트 (24M, 48kHz, 384k, High Profile)
- video-team-tasks.md 하드코딩 제거 (3000k → config 참조)
- ANALYSIS.md 섹션 6-7 "초기 분석" 명시
- audio_lra 11→20 수정, gemini-2.0→2.5 수정

### 4. LLM 모델 비교 분석 + 저비용 전략 확정
- 팀 제이 사용 가능 모델 10개 벤치마크 + 비용 종합 비교표 작성
- 저비용 프로토타입 전략 확정:
  자막교정: gpt-4o-mini ($0.15/$0.60) + fallback gemini-2.5-flash (무료)
  Critic: gemini-2.5-flash (무료)
  Refiner: groq/gpt-oss-20b (무료)
  Evaluator: groq/llama-4-scout (무료)
  월 20영상 예상: ~$1.12
- quality_loop config 블록 확장 (critic/refiner/evaluator 개별 모델)

### 5. 과제 1~5 구현 완료 (Claude Code/Codex 실행)


#### 과제 1: 프로젝트 스캐폴딩 + DB ✅
- config/video-config.yaml (YouTube 확정값 반영)
- migrations/001-video-schema.sql (video_edits 테이블)
- context/IDENTITY.md, src/index.js
- .gitignore (mp4/m4a/dfd_), temp/, exports/
- `node src/index.js` → config 로드 성공 + DB 연결 성공 + 렌더링 설정 24M 2560x1440

#### 과제 2: FFmpeg 전처리 ✅
- lib/ffmpeg-preprocess.js (removeAudio, normalizeAudio, syncVideoAudio, preprocess)
- 44100Hz mono → 48000Hz stereo 리샘플링 포함
- 테스트: removeAudio 229ms, normalizeAudio 19.6s, syncVideoAudio 6.4s, preprocess 50.6s
- LUFS: -14.9 (목표 -14 ± 2 범위 내)

#### 과제 3: Whisper STT ✅
- lib/whisper-client.js (transcribe, toSRT, generateSubtitle)
- 테스트: 17.2s, 67 segments, temp/subtitle_raw.srt 6.9KB
- SRT 한국어 정상: "지난 시간 우리는 동적 데이터..."
- 비용: $0.026

#### 과제 4: LLM 자막 교정 ✅
- lib/subtitle-corrector.js (correctSubtitle, correctFile + 청크분할 + 폴백)
- 테스트: 55.9s, 67/67 타임스탬프 보존, 비용 $0.002
- 폴백 체인: gpt-4o-mini → gemini-2.5-flash → 원본 SRT 유지

### 6. CapCut readiness 확인 ✅
- `/Users/alexlee/projects/CapCutAPI` 설치 + venv + requirements 설치 완료
- `capcut_server.py` 서버 9001 포트 실행 확인
- `CapCut.app` 실행 상태에서 `create_draft / save_draft` 성공 응답 확인
- 실제 draft 저장 위치는 `/Users/alexlee/projects/CapCutAPI/dfd_cat_*`
- 과제 5에서는 `save_draft` 후 repo 내부 draft를 `config.paths.capcut_drafts`로 복사해야 함

---

## 다음 세션에서 해야 할 것

### 과제 5: CapCutAPI 드래프트 생성 ✅
- `lib/capcut-draft-builder.js`
- `scripts/test-capcut-draft.js`
- `healthCheck, createDraft, addVideo, addAudio, addSubtitle, saveDraft, findDraftFolder, copyToCapCut, buildDraft` 구현 완료
- `temp/synced.mp4 + narr_norm.m4a + subtitle_corrected.srt` 기준 통합 테스트 통과
- `save_draft` 후 repo 내부 `dfd_cat_*`를 `config.paths.capcut_drafts`로 복사하는 흐름 검증 완료
- CapCut Desktop 프로젝트 목록에 새 draft 카드 실제 표시 확인

### 과제 6~7: draft 파서 + FFmpeg 렌더링 + 엔드투엔드 통합
### 과제 8~13: 워커웹 + n8n + 품질 루프 (Week 2)
### Week 3: 최종 통합 테스트 + 품질 테스트

---

## 프로젝트 현재 상태

```
ai-agent-system/bots/video/
├─ config/video-config.yaml        ✅ YouTube 확정값 (24M, 48kHz, 384k, faststart)
├─ context/IDENTITY.md             ✅ 비디오팀 정체성
├─ docs/
│   ├─ CLAUDE.md                   ✅ 규칙 + 확정값 (96줄)
│   ├─ SESSION_HANDOFF_VIDEO.md    ✅ 이 파일
│   ├─ VIDEO_HANDOFF.md            ✅ 인수인계 허브
│   ├─ video-automation-tech-plan.md ✅ 기술 기획서 (950줄)
│   ├─ video-team-design.md        ✅ 설계 문서 (739줄, config 업데이트 완료)
│   └─ video-team-tasks.md         ✅ 소과제 13개 + 프롬프트 (749줄)
├─ exports/.gitkeep                ✅
├─ lib/
│   ├─ ffmpeg-preprocess.js        ✅ 과제 2
│   ├─ whisper-client.js           ✅ 과제 3
│   ├─ subtitle-corrector.js       ✅ 과제 4
│   └─ capcut-draft-builder.js     ✅ 과제 5
├─ migrations/001-video-schema.sql ✅ video_edits 테이블
├─ samples/
│   ├─ ANALYSIS.md                 ✅ ffprobe + YouTube 분석 (190줄)
│   ├─ raw/ (5세트), narration/ (5세트), edited/ (5+18개)
├─ scripts/
│   ├─ test-preprocess.js          ✅ 과제 2 테스트
│   ├─ test-whisper.js             ✅ 과제 3 테스트
│   ├─ test-subtitle-corrector.js  ✅ 과제 4 테스트
│   ├─ check-capcut-readiness.js   ✅ 과제 5 전 readiness 체크
│   └─ test-capcut-draft.js        ✅ 과제 5 테스트
├─ src/index.js                    ✅ config + DB 연결
└─ temp/
    ├─ narr_norm.m4a               ✅ 정규화된 나레이션
    ├─ subtitle_raw.srt            ✅ Whisper 출력 (67 entries)
    └─ subtitle_corrected.srt      ✅ LLM 교정본
```

## 진행 현황

```
Week 1: 핵심 파이프라인
  ✅ 과제 1: 프로젝트 스캐폴딩 + DB
  ✅ 과제 2: FFmpeg 전처리
  ✅ 과제 3: Whisper STT
  ✅ 과제 4: LLM 자막 교정
  ✅ CapCut readiness 체크
  ✅ 과제 5: CapCut 드래프트
  ☐ 과제 6: draft 파서 + FFmpeg 렌더링
  ☐ 과제 7: 엔드투엔드 통합

Week 2: 워커웹 + n8n + 품질 루프
  ☐ 과제 8~13

Week 3: 최종 테스트 + 문서 체계 통합
```

## 핵심 결정사항

```
[확정] YouTube 렌더링: 24Mbps, H.264 High, 48kHz/384kbps, movflags +faststart, BT.709
[확정] 1440p 업로드 = VP9 코덱 트리거 (1080p 원본 → 2560x1440 업스케일)
[확정] CapCut 무료 + FFmpeg 렌더링 (Pro 불필요)
[확정] 저비용 LLM 전략: 자막 gpt-4o-mini, 품질루프 전부 무료 (월 ~$1.12)
[확정] Gemini 2.0 → 2.5-flash 변경 (2.0 퇴역 예정)
[확정] quality_loop: critic=gemini-2.5-flash, refiner=groq/gpt-oss-20b, evaluator=groq/scout
[확정] 대화형 UX 9단계 (워커웹)
[확정] 더백클래스 LMS 연동은 Phase 2+
```

## 크롬 탭 상태

```
tabId 284978451: "Flutterflow 중급 - YouTube" (플레이리스트)
tabId 284978582: "AI&NoCode 프리미엄 강의" (adminLectures — 로그인됨)
```

## LMS 학습 메모 (Phase 2 준비)

```
더백클래스 관리자 패널 접속 완료 (the100class.flutterflow.app/adminLectures)
좌측 메뉴: 회원/약관/강의/FAQ/멤버십/기타
카테고리 3개: 인스타1st SNS 앱(36), 컴팩트기초 서버(9), 컴팩트기초 로컬(10) = 총 56강의
아직 확인 안 한 것: 개별 강의 수정 폼, 신규 업로드 폼, 영상 호스팅 방식
```
