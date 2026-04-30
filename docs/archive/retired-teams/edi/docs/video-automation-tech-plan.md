# 유튜브 영상 편집 자동화 — 기술 구현 방안

> 작성일: 2026-03-20
> 전략 담당: 메티 (claude.ai)
> 마스터: Jay (Alex)
> 프로젝트 경로: /Users/alexlee/projects/ai-agent-system/bots/video/

---

## 1. 방향 정의

```
프로토타입: Case 1 (원본 영상 편집) — 즉시 구현
기획 보류: Case 2 (완전 자동 생성) — 설계 단계부터 확장 고려
원칙: Case 2를 위한 인터페이스/모듈 경계를 미리 정의하되, 구현은 Case 1만 진행
```

---

## 2. 편집 루틴 (마스터 확정)

### 2-1. 작업 순서

```
[수동 유지]
  1. 영상 녹화 → 원본_*.mp4 (1920×1080, H.264 High, 60fps)
  2. 나레이션 대본 제작
  3. 나레이션 녹음 → 원본_나레이션_*.m4a (AAC, 44100Hz, 모노, 65kbps)

[자동화 대상]
  4. 편집 진행
     1) 음성 + 영상 싱크 편집 (음성 값 최적화 포함)
     2) 음성 캡션 추출 (한글 자막)
     3) 캡션 오탈자 및 싱크 편집
     4) 기타 효과음 및 영상 효과 편집 (필요한 부분만)
     5) 최종 렌더링 → FFmpeg로 편집_*.mp4 (2560×1440, H.264, 60fps)
        ★ CapCut에서 Export하지 않음 (편집 상태 유지)
        → CapCut 무료 플랜 제한(1080p/30fps) 완전 우회
```

### 2-2. 실제 영상 데이터 분석 (ffprobe 기반)

```
영상 5세트 평균:
  원본 영상: 44.8분 (142.5~45.0MB, 비트레이트 252~327kbps)
  나레이션:   8.6분 (2.1~6.9MB, 비트레이트 65kbps 고정)
  편집 결과: 17.7분 (167.8~737.9MB, 비트레이트 2610~3507kbps)

핵심 발견:
  - 원본 오디오는 2kbps (사실상 무음) → 나레이션으로 완전 교체 구조
  - 편집 시 해상도 1080p → 1440p 업스케일 + 비트레이트 10배 증가
  - 평균 컷팅률 69% (원본 대비 삭제 비율)
  - 3번(서버인증)만 편집본이 원본보다 김 → 보충 화면 삽입 케이스 존재
```

---

## 3. 기술 스택 결정

### 3-1. 커뮤니티 검토 결과

```
3가지 접근법 비교 후 결정:

  A. 제이 스택 (Claude + Hub control + Agent + n8n + RAG + FFmpeg + Whisper)
     → 월 $0.64, 완전 커스텀, 팀 제이 통합 가능 ✅ 선택

  B. 클라우드 API (Shotstack + AssemblyAI + Zapier)
     → 월 $74, 인프라 불필요하나 비용 과다 ❌

  C. 올인원 SaaS (Descript, FocuSee, Camtasia)
     → 월 $33, IT 전문용어 교정 불가, 팀 제이 통합 불가 ❌

커뮤니티 보강 사항 3가지:
  1. FFmpeg 8.0 — Whisper 필터 내장 (STT를 FFmpeg 파이프라인에 통합)
  2. n8n 커뮤니티 — Whisper+FFmpeg 워크플로우 템플릿 활용 (구축 시간 50% 단축)
  3. Shotstack — Case 2 대량 렌더링 시에만 선택적 도입 (Phase 2+)
```

### 3-2. 확정 기술 스택

```
┌──────────────────────────────────────────────────────────┐
│ 오케스트레이션 계층                                       │
│  Claude (전략/프롬프트) + Hub control (에이전트 관리)      │
│  n8n (워크플로우 자동화)                                  │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ 전처리 계층 (FFmpeg + AI)                                 │
│  FFmpeg 8.1 (로컬) — 오디오 정규화 + 오디오 추출          │
│  Whisper API ($0.006/분) — STT + SRT 자막 생성            │
│  LLM 셀렉터 (자막 교정) — 설정에서 모델 선택 가능:        │
│    ├ GPT-4o Mini  ($0.15/M input)  — 기본값, 최저가      │
│    ├ GPT-4o       ($2.50/M input)  — 고품질 교정         │
│    ├ Claude Sonnet ($3.00/M input) — IT용어 정확도 우수   │
│    └ Gemini Flash ($0.10/M input)  — 최저가 대안         │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ AI 싱크 매칭 계층 (Phase 2)                               │
│  scene-indexer (OCR+LLM) — 원본 전체 장면 인덱싱          │
│  narration-analyzer (STT+LLM) — 나레이션 구간 분석        │
│  sync-matcher (키워드+임베딩) — 장면 자동 매칭            │
│  intro-outro-handler — 파일/프롬프트 하이브리드           │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ ★ CapCut 편집 계층 (핵심 — 기존 FFmpeg 렌더링 대체)       │
│  CapCutAPI (오픈소스, MCP 프로토콜 지원)                   │
│    ├ HTTP API: localhost:9001                             │
│    ├ MCP Server: Hub/Claude와 직접 연동                   │
│    ├ 기능: create_draft, add_video, add_audio,            │
│    │       add_subtitle, add_effect, save_draft           │
│    └ 출력: dfd_ 폴더 → CapCut 드래프트 디렉토리에 복사    │
│  CapCut Desktop — 드래프트 임포트 → 마스터 확인 → Export   │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ 품질 검증 계층 (Critic-Refiner-Evaluator 루프)            │
│  Critic Agent (RED) — 드래프트 분석, 문제점 발굴           │
│  Refiner Agent (BLUE) — CapCutAPI로 드래프트 자동 수정     │
│  Evaluator Agent — 품질 점수 판정 (85/100 목표)           │
│  → 2~3회 순환 후 마스터에게 전달                           │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│ 저장 계층                                                │
│  CapCut 로컬 드래프트 — 편집 UI + 프리뷰 (Export 안 함)   │
│  FFmpeg — 최종 렌더링 (1440p/60fps, 제한 없음)            │
│  PostgreSQL (jay DB) — 편집 이력, 메타데이터, RAG 벡터     │
│  로컬 파일시스템 — 원본 소스 + FFmpeg 출력                 │
│  RAG/pgvector — 편집 패턴 학습 (Phase 2+)                 │
└──────────────────────────────────────────────────────────┘
```

### 3-3. 비용 산출 (근거 명시)

```
산출 기준:
  - 나레이션: 직접 녹음 (TTS 비용 $0)
  - 영상 1건 평균 나레이션: 8.6분
  - 생산량: 월 12편 (주 3편)

항목별 비용:
  ┌─────────────────────┬────────────────────┬─────────┬──────────┐
  │ 구성 요소            │ 단가 (출처)         │ 1건당    │ 월 12편   │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ Whisper API (STT)   │ $0.006/분          │ $0.052  │ $0.62    │
  │                     │ (OpenAI 공식 가격)  │         │          │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ LLM 셀렉터 (교정) │ 모델별 상이       │ $0.002  │ $0.02    │
  │  기본: GPT-4o Mini │ $0.15/M input      │ (최저)  │ (최저)   │
  │  고품질: GPT-4o    │ $2.50/M input      │ $0.03   │ $0.36    │
  │  정확도: Claude    │ $3.00/M input      │ $0.04   │ $0.48    │
  │  대안: Gemini Flash│ $0.10/M input      │ $0.001  │ $0.01    │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ FFmpeg (로컬)       │ $0 (오픈소스)       │ $0      │ $0       │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ n8n (셀프호스트)    │ $0 (오픈소스)       │ $0      │ $0       │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ Hub control + RAG   │ $0 (로컬/기존 인프라)│ $0      │ $0       │
  ├─────────────────────┼────────────────────┼─────────┼──────────┤
  │ 합계                │                    │ $0.054  │ $0.64/월 │
  │                     │                    │         │ $7.68/년 │
  └─────────────────────┴────────────────────┴─────────┴──────────┘

  대안: Whisper 로컬 실행 시 → 월 $0.01~0.48 (LLM 교정 모델에 따라)

  주의사항:
  - Claude Max $200/월은 팀 제이 운영에 포함 (별도 산정 안 함)
  - GPT-4o Mini Transcribe ($0.003/분)는 타임스탬프 미지원
    → SRT 자막 생성에는 Whisper API 필수
  - LLM 셀렉터로 자막 교정 모델을 자유롭게 선택 가능
    → 기본값: GPT-4o Mini (최저가)
    → 교정 품질 불만족 시: Claude Sonnet 또는 GPT-4o로 상향
    → 비용 최소화 시: Gemini Flash로 하향
  - 팀 제이 기존 LLM 하이브리드 패턴과 동일 구조
    (config.yaml에서 봇별 모델 교체 가능)
```

---

## 4. 편집 단계별 구현 방안

### 4-1. 단계 1) 음성+영상 싱크 편집 [완전 자동화]

```
입력: 원본_*.mp4 + 원본_나레이션_*.m4a
출력: synced_*.mp4 (나레이션 합성 + 오디오 정규화)

★★ Phase 2 전환 (2026-03-21) ★★
위의 단순 합성 방식은 폐기됨.
Phase 2에서는 원본 전체를 OCR 장면 인덱싱 → 나레이션 구간별 AI 매칭 → EDL 기반 멀티 클립 합성으로 전환한다.
상세는 bots/video/docs/CLAUDE.md 의 "AI 싱크 매칭 파이프라인" 섹션을 source of truth로 본다.

처리 흐름:
  1. FFmpeg로 원본 영상의 오디오 트랙 제거
     → ffmpeg -i 원본.mp4 -an -c:v copy video_only.mp4

  2. 나레이션 오디오 정규화 (-14 LUFS)
     → ffmpeg -i 나레이션.m4a -af loudnorm=I=-14:TP=-1:LRA=11 narr_norm.m4a

  3. 영상 + 정규화된 나레이션 합성
     → ffmpeg -i video_only.mp4 -i narr_norm.m4a -c:v copy -c:a aac synced.mp4

  확장 고려 (Case 2):
    - 이 단계의 인터페이스를 "오디오 소스"로 추상화
    - Case 1: 직접 녹음 m4a → 입력
    - Case 2: TTS API 생성 음성 → 동일 인터페이스로 입력
    → 코드 변경 없이 오디오 소스만 교체 가능하도록 설계
```

### 4-2. 단계 2) 음성 캡션 추출 [완전 자동화]

```
입력: 원본_나레이션_*.m4a
출력: subtitle_*.srt (타임스탬프 포함 한글 자막)

처리 흐름:
  1. Whisper API 호출 (verbose_json + word timestamps)
     → POST /v1/audio/transcriptions
       model: "whisper-1"
       language: "ko"
       response_format: "verbose_json"
       timestamp_granularities: ["word", "segment"]

  2. JSON → SRT 변환 (n8n Python 노드 또는 스크립트)

  비용: 나레이션 8.6분 → $0.052/건

  대안 (로컬): FFmpeg 8.0+ Whisper 필터
     → ffmpeg -i 나레이션.m4a -af whisper=model=large-v3:language=ko output.srt
     → 비용 $0, 다만 처리 속도 느림 (M칩 CPU 기준 실시간의 2~3배)

  확장 고려 (Case 2):
    - Case 2에서는 TTS가 텍스트→음성이므로 원본 텍스트가 이미 존재
    - STT 단계 자체가 불필요 (텍스트에서 직접 SRT 생성 가능)
    → 입력 타입 분기: m4a → Whisper STT / text → direct SRT 생성
```

### 4-3. 단계 3) 캡션 오탈자 및 싱크 편집 [완전 자동화]

```
입력: subtitle_*.srt (Whisper 생성 자막)
출력: subtitle_corrected_*.srt (교정된 자막)

처리 흐름:
  1. SRT 파일 파싱 → 텍스트 추출
  2. LLM 셀렉터에서 선택된 모델로 API 호출

  LLM 셀렉터 설계:
    ┌──────────────────────────────────────────────────────────┐
    │ config.yaml (또는 n8n 환경변수)                           │
    │                                                          │
    │ subtitle_correction:                                     │
    │   llm_provider: "openai"      # openai | anthropic |    │
    │                                # google                  │
    │   llm_model: "gpt-4o-mini"    # 모델명                  │
    │   fallback_provider: "google"  # 폴백 프로바이더          │
    │   fallback_model: "gemini-2.0-flash"  # 폴백 모델       │
    │   max_retries: 2              # 실패 시 폴백 전 재시도    │
    │   temperature: 0.1            # 교정 작업은 낮은 온도     │
    └──────────────────────────────────────────────────────────┘

  지원 모델 및 비용 (자막 ~2,000자 기준):
    ┌─────────────────┬──────────────┬──────────┬────────────┐
    │ 모델             │ 입력 단가     │ 건당 비용 │ 특징        │
    ├─────────────────┼──────────────┼──────────┼────────────┤
    │ GPT-4o Mini     │ $0.15/M tok  │ ~$0.002  │ 최저가 기본값│
    │ GPT-4o          │ $2.50/M tok  │ ~$0.03   │ 고품질 교정  │
    │ Claude Sonnet   │ $3.00/M tok  │ ~$0.04   │ IT용어 우수  │
    │ Gemini Flash    │ $0.10/M tok  │ ~$0.001  │ 초저가 대안  │
    └─────────────────┴──────────────┴──────────┴────────────┘

  셀렉터 동작 로직:
    1. config에서 llm_provider + llm_model 읽기
    2. 해당 API 호출 (통합 인터페이스)
    3. 실패 시 → max_retries 재시도
    4. 재시도 실패 → fallback_provider/model로 자동 전환
    5. 폴백도 실패 → 원본 SRT 유지 + 마스터 알림

  통합 인터페이스 (코드 설계):
    // callLLM(provider, model, systemPrompt, userInput) → correctedText
    // provider별 API 엔드포인트/키 매핑은 내부에서 처리
    // 팀 제이 기존 callOpenAI/callGemini 패턴과 동일 구조

  프롬프트 설계 (모든 LLM 공통):
    시스템: "FlutterFlow, Firebase, Supabase 등 IT 전문용어에 익숙한
            한국어 자막 교정 전문가. 오탈자, 띄어쓰기, 기술 용어 오류를 수정.
            타임스탬프(00:01:23,456 형식)는 절대 수정하지 않는다.
            교정된 SRT 형식 그대로 출력한다."
    입력: SRT 텍스트 전체
    출력: 교정된 SRT 텍스트 (타임스탬프 유지)

  확장 고려 (Case 2):
    - Case 2에서도 동일한 교정 파이프라인 + 셀렉터 사용
    - TTS 텍스트 → SRT → 교정 흐름 동일
    → 이 모듈은 Case 1/2 공용
```

### 4-4. 단계 4) CapCut 드래프트 자동 생성 [완전 자동화] ★ 핵심 변경

```
입력: synced.mp4 + subtitle_corrected.srt
출력: CapCut 드래프트 폴더 (dfd_*)

  ★ 아키텍처 변경 사항:
    기존: FFmpeg가 편집+렌더링 모두 수행, CapCut은 "최종 확인용"
    수정: Hub/Video agent가 CapCutAPI(MCP)를 통해 CapCut 드래프트를 자동 생성
          → CapCut의 풍부한 효과/전환/자막 스타일 그대로 활용
          → 마스터 작업이 "처음부터 편집" → "드래프트 확인 + 미세조정"으로 축소

  CapCutAPI (오픈소스, github.com/sun-guannan/VectCutAPI):
    - Python 기반, HTTP API + MCP 프로토콜 이중 인터페이스
    - Apache 2.0 라이선스, CapCut Desktop과 연동
    - save_draft → dfd_ 폴더 생성 → CapCut 드래프트 디렉토리에 복사

  처리 흐름:
    1. Hub/Video agent → CapCutAPI MCP 서버에 연결
       → MCP config:
         {
           "mcpServers": {
             "capcut-api": {
               "command": "python3",
               "args": ["mcp_server.py"],
               "cwd": "/path/to/CapCutAPI"
             }
           }
         }

    2. create_draft → 새 프로젝트 생성
       → POST http://localhost:9001/create_draft

    3. add_video → 원본 영상 (또는 synced.mp4) 타임라인 배치
       → POST http://localhost:9001/add_video
         { "video_url": "synced.mp4", "start": 0, "end": duration }

    4. add_audio → 정규화된 나레이션 오디오 트랙 추가
       → POST http://localhost:9001/add_audio
         { "audio_url": "narr_norm.m4a", "volume": 1.0 }

    5. add_subtitle → 교정된 SRT 자막 삽입
       → POST http://localhost:9001/add_subtitle
         { "subtitle_file": "subtitle_corrected.srt" }

    6. add_effect → 기본 효과 적용 (Phase 2: RAG 패턴 기반)
       → POST http://localhost:9001/add_effect
         { "effect_type": "transition", "style": "fade_in" }

    7. save_draft → CapCut 드래프트 파일 저장
       → dfd_ 폴더 → CapCut 드래프트 디렉토리에 자동 복사
       → CapCut 클라우드 자동 동기화 (로그인 상태 시)

  ★ CapCut을 "편집 워크스페이스"로 활용:
    기존: 자동화 → 로컬에 편집본 MP4 저장 (GB급 누적)
    수정: 자동화 → CapCut 드래프트만 생성 (경량 메타데이터)
          → 마스터가 CapCut Desktop에서 열어 확인/수정
          → 만족 시 Export → 그때만 최종 MP4 생성

    장점:
      - 로컬에 GB급 편집본 MP4를 쌓을 필요 없음
      - 드래프트 = 원본 파일 참조 + 편집 메타데이터(JSON) → 매우 경량
      - 최종 렌더링은 마스터가 Export할 때 1회만 발생

    ★ CapCut 무료 플랜 제약 → "편집 상태 유지" 전략으로 전부 해결:
      ┌──────────────────┬──────────────┬──────────────────┐
      │ 항목              │ 무료 제약     │ 우회 방법         │
      ├──────────────────┼──────────────┼──────────────────┤
      │ Export 해상도     │ 1080p 최대    │ Export 안 함      │
      │                  │              │ → FFmpeg 1440p   │
      │ Export fps        │ 30fps        │ Export 안 함      │
      │                  │              │ → FFmpeg 60fps   │
      │ 클라우드 동기화   │ ✗ 불가        │ 로컬 드래프트로   │
      │                  │              │ 충분 (맥북 리뷰)  │
      │ 워터마크          │ 프리미엄 사용시│ FFmpeg 출력에는   │
      │                  │              │ 워터마크 없음     │
      │ AI 도구           │ 기본만        │ Whisper+LLM으로  │
      │                  │              │ 자체 구현 완료    │
      │ 비용              │ $0           │ $0 유지           │
      └──────────────────┴──────────────┴──────────────────┘

    → CapCut Pro 구독 불필요! 무료 플랜 + FFmpeg로 모든 요구사항 달성

  로컬에 유지하는 파일 (원본 소스만):
    - 원본_*.mp4 (원본 영상 — 드래프트가 참조)
    - 원본_나레이션_*.m4a (나레이션 — 드래프트가 참조)
    - subtitle_corrected.srt (교정된 자막)
    → 이 파일들은 CapCut 드래프트가 참조하므로 유지 필요
    → 최종 Export 후 아카이빙 or 삭제 가능

  FFmpeg의 역할 변경:
    기존: 편집 + 렌더링 + 자막 번인 전부 담당
    수정: 전처리만 (오디오 정규화, 오디오 추출, 필요 시 포맷 변환)
          렌더링은 CapCut Desktop에서 Export

  확장 고려 (Case 2):
    - Case 2에서도 CapCutAPI로 동일하게 드래프트 생성
    - TTS 음성 + AI 생성 이미지 → add_audio + add_image
    → CapCut 편집 모듈은 Case 1/2 공용
```

### 4-5. 단계 5) 품질 검증 + 마스터 리뷰 + FFmpeg 최종 렌더링

```
★ 핵심 전환: CapCut에서 Export하지 않는다!
  CapCut = 편집 UI + 프리뷰 확인 전용 (편집 상태 유지)
  FFmpeg = 최종 렌더링 (1440p/60fps, 무료, 제한 없음)
  → CapCut 무료 플랜의 1080p/30fps 제한 완전 우회
  → CapCut Pro 구독 불필요

  CapCut 드래프트 → FFmpeg 변환이 가능한 이유:
    - CapCut 드래프트 = JSON 메타데이터 파일
      macOS: /Users/user/Movies/CapCut/User Data/Projects/
             com.lveditor.draft/draft_info.json
    - JSON에 타임라인, 클립 순서, in/out 포인트, 효과, 자막 등
      모든 편집 정보가 포함됨
    - capcut-export (npm 패키지) — 드래프트 JSON → FFmpeg 명령어
      자동 변환 오픈소스 도구 존재

입력: CapCut 드래프트 (편집 상태 유지)
출력: 편집_*.mp4 (2560×1440, H.264, 60fps) — FFmpeg 렌더링

  처리 흐름:
    1. 품질 검증 루프 (Critic-Refiner-Evaluator)
       → 상세: 섹션 6. RED/BLUE Team 품질 검증 참조

    2. 검증 통과 후 → 마스터에게 텔레그램 알림
       "✅ CapCut 드래프트 준비 완료 (품질 점수: 87/100)
        CapCut Desktop에서 프리뷰 확인해주세요"

    3. ★ 마스터 리뷰 (CapCut Desktop — 편집 상태):
       - CapCut Desktop 열기 → 드래프트 프리뷰로 내용 확인
       - 자막/효과/전환 수정이 필요하면 CapCut에서 직접 수정
       - ★ Export 버튼 누르지 않음! (편집 상태 그대로 유지)
       - 텔레그램으로 "OK" 회신 (또는 수정 후 "OK")

    4. ★ FFmpeg 최종 렌더링 (마스터 OK 후 자동 실행):
       - draft_info.json 파싱 → 편집 정보 추출
       - FFmpeg 명령어 생성:
         · 비디오 트랙: 클립 순서 + in/out 포인트 기반 concat
         · 오디오 트랙: 나레이션 합성 + LUFS 정규화
         · 자막: SRT 번인 (ASS 스타일 적용 가능)
         · 해상도: scale=2560:1440:flags=lanczos
         · 인코딩: H.264, 3000kbps, 60fps
       - 렌더링 시간: ~5분 (M칩 하드웨어 가속)
       - 출력: 편집_*.mp4 → exports/ 폴더

    5. 유튜브 업로드 후 Export 파일 삭제 가능

  마스터가 CapCut에서 수정한 경우:
    → CapCut이 draft_info.json을 자동 업데이트
    → FFmpeg 렌더링 시 최신 JSON을 읽으므로 수정사항 자동 반영

  이 구조의 장점:
    ┌─────────────────────┬──────────────────────────────────┐
    │ 항목                 │ 효과                              │
    ├─────────────────────┼──────────────────────────────────┤
    │ CapCut Pro 불필요    │ 무료 플랜으로 편집 기능 전부 사용  │
    │ 해상도 제한 없음     │ FFmpeg로 1440p/4K 자유롭게 렌더링 │
    │ fps 제한 없음        │ 60fps 출력 가능                   │
    │ 워터마크 없음        │ FFmpeg 출력에는 워터마크 없음      │
    │ 클라우드 불필요      │ 로컬 드래프트만으로 운영           │
    │ 편집 UI 완전 활용    │ CapCut의 효과/전환/자막 스타일    │
    │ 비용                 │ $0 (CapCut 무료 + FFmpeg 무료)    │
    └─────────────────────┴──────────────────────────────────┘
```

---

## 5. 확장 가능 아키텍처 설계

### 5-1. 모듈 경계 정의

```
모든 모듈은 입력/출력 인터페이스로 분리:

┌─────────────────────────────────────────────────────────────┐
│ AudioSource 인터페이스                                       │
│  Case 1: LocalFile (m4a 직접 녹음)                          │
│  Case 2: TTSGenerated (ElevenLabs/OpenAI TTS API 생성)      │
│  → 동일한 출력: normalized_audio.m4a                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ VideoSource 인터페이스                                       │
│  Case 1: ScreenRecording (원본_*.mp4 화면 녹화)              │
│  Case 2: AIGenerated (이미지 슬라이드쇼 / 코드 애니메이션)    │
│  → 동일한 출력: source_video.mp4                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SubtitleGenerator 인터페이스                                  │
│  Case 1: WhisperSTT (m4a → SRT 변환)                        │
│  Case 2: TextToSRT (대본 텍스트 → SRT 직접 생성)             │
│  → 동일한 출력: subtitle.srt                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 공용 모듈 (Case 1/2 동일)                                    │
│  SubtitleCorrector — LLM 셀렉터 기반 오탈자/IT용어 교정      │
│    ├ config.yaml에서 provider/model 선택                     │
│    ├ 실패 시 자동 폴백 (예: OpenAI 장애 → Gemini 전환)        │
│    └ 팀 제이 callLLM 통합 인터페이스 패턴 재사용              │
│  AudioNormalizer — FFmpeg LUFS 정규화 (전처리)               │
│  CapCutDraftBuilder — CapCutAPI MCP로 드래프트 자동 생성     │
│    ├ create_draft → add_video/audio/subtitle/effect          │
│    ├ save_draft → CapCut 로컬 드래프트 (편집 상태 유지)      │
│    └ draft_info.json 파싱 → FFmpeg 렌더링 (Export 우회)      │
│  QualityLoop — Critic-Refiner-Evaluator 순환 검증            │
│    ├ Phase 1: 기본 메트릭 (자막 싱크, 오디오 밸런스)          │
│    └ Phase 2: 전체 메트릭 (시청자 집중도, 화면 구성 등)       │
└─────────────────────────────────────────────────────────────┘
```

### 5-2. n8n 워크플로우 설계

```
[Case 1 워크플로우 — 프로토타입 (CapCut 중심)]

  트리거: 파일 감시 (video_edit_sample/N/ 폴더에 원본+나레이션 도착)
    │
    ├─ Step 1: FFmpeg 전처리
    │   ├ 원본 오디오 제거 + 나레이션 LUFS 정규화
    │   └ 출력: synced.mp4 + narr_norm.m4a
    │
    ├─ Step 2: Whisper API STT
    │   ├ 입력: 원본_나레이션_*.m4a
    │   └ 출력: subtitle_raw.srt (타임스탬프 포함)
    │
    ├─ Step 3: LLM 셀렉터 → 자막 교정
    │   ├ 입력: subtitle_raw.srt + config(provider/model)
    │   └ 출력: subtitle_corrected.srt
    │
    ├─ Step 4: ★ CapCutAPI → 드래프트 자동 생성
    │   ├ Hub/Video agent → CapCutAPI MCP 연결
    │   ├ create_draft → add_video → add_audio → add_subtitle
    │   ├ (Phase 2: add_effect — RAG 패턴 기반)
    │   └ save_draft → dfd_ 폴더 생성
    │
    ├─ Step 5: ★ 품질 검증 루프 (Critic-Refiner-Evaluator)
    │   ├ Critic: 드래프트 분석 → 문제점 리포트
    │   ├ Refiner: CapCutAPI로 드래프트 수정
    │   ├ Evaluator: 품질 점수 판정
    │   └ 루프: 85점 미만 → Step 5 반복 (최대 3회)
    │
    ├─ Step 6: dfd_ 폴더 → CapCut 로컬 드래프트 디렉토리에 복사
    │
    ├─ 알림: 텔레그램
    │   "✅ 편집 드래프트 완료 (품질: 87/100)
    │    CapCut Desktop에서 프리뷰 확인 후 OK 회신하세요"
    │
    ├─ 대기: 마스터 텔레그램 "OK" 회신 (또는 수정 후 "OK")
    │
    └─ Step 7: ★ FFmpeg 최종 렌더링
        ├ draft_info.json 파싱 → 편집 정보 추출
        ├ FFmpeg: 1440p/60fps 렌더링 (CapCut Export 우회)
        ├ 출력: exports/편집_*.mp4
        └ 알림: 텔레그램 "🎬 렌더링 완료 → 유튜브 업로드 준비됨"


[Case 2 워크플로우 — 기획만]

  트리거: 텍스트 파일 도착 (case2_text_input/)
    │
    ├─ Step 0: Claude → 스크립트 분석 + 장면 분해
    ├─ Step 0.5: TTS API → 음성 생성 (AudioSource 교체)
    ├─ Step 0.7: 이미지/슬라이드 생성 (VideoSource 교체)
    │
    ├─ Step 1~6: Case 1과 동일한 파이프라인
    │   (전처리 → STT → 교정 → CapCut 드래프트 → 품질 검증)
    │
    └─ 알림: 텔레그램 "완전 자동 생성 완료"
```

### 5-3. 팀 제이 통합 + 프로젝트 구조

```
★ 결정: ai-agent-system 레포에 통합 (별도 프로젝트 X)

  이유:
    - packages/core/lib/의 기존 모듈 12개 재사용 가능
      (pg-pool, llm-router, llm-fallback, llm-logger, telegram-sender,
       rag, n8n-runner, heartbeat, kst 등)
    - Dexter 모니터링 대상에 포함
    - bots/blog/과 동일한 패턴 (코드는 레포, 콘텐츠 파일은 외부)

  프로젝트 구조:
    ai-agent-system/                (git 레포)
    ├─ bots/video/                  ← NEW
    │   ├─ lib/
    │   │   ├─ ffmpeg-preprocess.js   (오디오 정규화, 추출)
    │   │   ├─ whisper-client.js      (STT API 호출)
    │   │   ├─ subtitle-corrector.js  (LLM 셀렉터 → 교정)
    │   │   ├─ capcut-draft-builder.js(CapCutAPI MCP 연동)
    │   │   └─ quality-loop.js        (Critic-Refiner-Evaluator)
    │   ├─ config.yaml                (LLM 모델, 경로, CapCut 설정)
    │   └─ index.js
    ├─ bots/blog/                   (기존 블로팀 — 동일 패턴)
    ├─ bots/ska/                    (기존 스카팀)
    ├─ packages/core/lib/           (공유 모듈 — 재구현 불필요!)
    └─ .gitignore                   (*.mp4, *.m4a, dfd_*/ 제외)

  ★ 스토리지 정책: "CapCut 편집 상태 유지 + FFmpeg 렌더링"

    ┌───────────────────┬────────────────────────────────────┐
    │ 파일 종류          │ 저장 위치                           │
    ├───────────────────┼────────────────────────────────────┤
    │ 원본_*.mp4 (녹화)  │ 로컬 (flutterflow_video/sources/)  │
    │ 원본_나레이션_*.m4a│ 로컬 (flutterflow_video/sources/)  │
    │ subtitle_*.srt    │ 로컬 (flutterflow_video/temp/)     │
    │ 편집 드래프트      │ CapCut 로컬 드래프트 디렉토리       │
    │ (draft_info.json) │ ★ 편집 상태 유지, Export 안 함      │
    │ 편집본 MP4 (최종)  │ FFmpeg 렌더링 → exports/ 폴더      │
    │                   │ 유튜브 업로드 후 삭제 가능           │
    │ 코드 (bots/video/) │ git 레포 (ai-agent-system)         │
    └───────────────────┴────────────────────────────────────┘

    핵심: CapCut에서 Export하지 않으므로
      - CapCut Pro 불필요 (무료 플랜으로 충분)
      - 해상도/fps 제한 없음 (FFmpeg가 1440p/60fps 렌더링)
      - 워터마크 없음 (FFmpeg 출력)
      - 클라우드 불필요 (로컬 드래프트 + 맥북 리뷰)
    flutterflow_video/                (git 밖, 원본 소스 전용)
    ├─ sources/1~N/                   (원본 + 나레이션)
    │   ├─ 원본_*.mp4
    │   └─ 원본_나레이션_*.m4a
    ├─ temp/                          (처리 중 임시 — 자동 정리)
    │   ├─ synced.mp4
    │   ├─ subtitle_raw.srt
    │   └─ subtitle_corrected.srt
    └─ exports/                       (마스터 Export 후 임시 보관)
        └─ 편집_*.mp4                 (유튜브 업로드 후 삭제)

기존 팀 제이 시스템과의 연결 포인트:

  - PostgreSQL (jay DB): 편집 이력 테이블 추가
    → video_edits 테이블: id, title, source_path, draft_name,
      whisper_cost, gpt_cost, quality_score, status, created_at
    → output_path 대신 draft_name (CapCut 드래프트 이름으로 추적)

  - 텔레그램 알림: Hub alarm governor + Telegram topic 활용
    → 드래프트 준비 완료/품질 점수/검토 요청 알림

  - RAG (pgvector): 편집 패턴 벡터 저장
    → Phase 2에서 활성화

  - launchd: 스케줄러 (기존 팀 제이 패턴)
    → n8n 파일 감시 + launchd 백업 트리거
```

---

## 6. RED/BLUE Team 품질 검증 시스템

### 6-1. 커뮤니티 검증 결과

```
커뮤니티에서 검증된 3가지 패턴을 기반으로 설계:

  1. n8n Critic-Refiner-Evaluator 패턴
     → n8n 커뮤니티 워크플로우 템플릿 (#5597)
     → 3개 전문 AI 에이전트가 콘텐츠를 반복적으로 개선
     → Critic이 분석 → Refiner가 수정 → Evaluator가 판정
     → 목표 달성 또는 최대 반복까지 루프

  2. Purple Teaming 수렴 패턴
     → RED vs BLUE 대립이 아닌, 하나의 루프 안에서 협력
     → "분석→수정→재평가" 순환이 핵심
     → 영상 편집은 보안과 달리 적대적일 필요 없음

  3. 반복 비용 제로 시대
     → 2026년 영상 제작은 선형 파이프라인 → 반복 루프로 전환
     → 반복 비용이 거의 $0이므로 "10개 옵션 중 최선 선택" 가능
     → 병목이 제작 역량 → 승인 속도로 이동
```

### 6-2. 3-Agent 아키텍처 (경량 프로토타입)

```
이전 대화의 RED 5명 + BLUE 5명(총 10명) 설계를 경량화:
  Phase 1: Critic(1) + Refiner(1) + Evaluator(1) = 3 에이전트
  Phase 2: 전문 에이전트 추가 (시청자 집중도, 화면 구성 등)

┌──────────────────────────────────────────────────────────────┐
│                   CapCut 드래프트 (V1)                        │
└──────────────────────┬───────────────────────────────────────┘
                       │
         ╔═════════════╩═════════════╗
         ║  품질 검증 루프 시작        ║
         ╚═════════════╦═════════════╝
                       │
         ┌─────────────▼──────────────┐
         │ 🔴 Critic Agent (RED)      │
         │  입력: 드래프트 메타데이터   │
         │  분석: 자막 싱크, 오디오    │
         │        밸런스, 구조 검증    │
         │  출력: 문제점 리포트 JSON   │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │ 🔵 Refiner Agent (BLUE)    │
         │  입력: 리포트 + 드래프트   │
         │  수정: CapCutAPI로 자동     │
         │        드래프트 패치        │
         │  출력: 수정된 드래프트 V(n) │
         └─────────────┬──────────────┘
                       │
         ┌─────────────▼──────────────┐
         │ ⚖️ Evaluator Agent         │
         │  입력: 수정된 드래프트      │
         │  판정: 품질 점수 계산       │
         │  기준: 85/100 이상 = 통과   │
         └─────────────┬──────────────┘
                       │
                 ┌─────▼─────┐
                 │ 85점 이상? │
                 └──┬─────┬──┘
              Yes   │     │   No (최대 3회)
         ┌──────────┘     └───────────┐
         ▼                            ▼
  ┌──────────────┐          ┌─────────────────┐
  │ 마스터에게    │          │ Critic으로 복귀  │
  │ 드래프트 전달 │          │ (V2 → V3 순환)  │
  └──────────────┘          └─────────────────┘
```

### 6-3. Critic Agent (RED Team) 상세

```
역할: CapCut 드래프트의 품질 문제점 발굴

Phase 1 검증 항목 (프로토타입):
  ┌─────────────────┬────────┬─────────────────────────────┐
  │ 항목             │ 가중치  │ 검증 방법                    │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 자막 타이밍 정확도│ 30%    │ SRT 타임스탬프 vs 오디오     │
  │                 │        │ 파형 비교 (±200ms 허용)      │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 오디오 밸런스    │ 25%    │ FFmpeg loudnorm 측정         │
  │                 │        │ 나레이션 LUFS 범위 확인       │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 자막 텍스트 품질 │ 25%    │ LLM 재검증 (오탈자 잔존 확인)│
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 구조 완전성      │ 20%    │ 드래프트에 video/audio/       │
  │                 │        │ subtitle 트랙 존재 확인      │
  └─────────────────┴────────┴─────────────────────────────┘

Phase 2 추가 검증 항목 (고도화):
  ┌─────────────────┬────────┬─────────────────────────────┐
  │ 시청자 집중도    │ 30%    │ 장면 지속시간 분석           │
  │                 │        │ (IT 강의 최적: 2~4초/장면)   │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 화면 구성       │ 25%    │ 정보 계층 구조 분석          │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 시각 임팩트     │ 20%    │ 전환 효과 적절성 검증        │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 정보 명확성     │ 15%    │ 초보자 관점 이해도 검증      │
  ├─────────────────┼────────┼─────────────────────────────┤
  │ 브랜드 일관성   │ 10%    │ 채널 스타일 가이드 매칭      │
  └─────────────────┴────────┴─────────────────────────────┘

  LLM: config.yaml의 LLM 셀렉터에서 선택
    Phase 1: GPT-4o Mini (비용 최소화)
    Phase 2: Opus 또는 Sonnet (정교한 분석 필요 시)

  출력 형식 (JSON):
    {
      "issues": [
        {
          "id": "TIMING_001",
          "severity": "HIGH",
          "category": "subtitle_sync",
          "timestamp": "0:45-0:52",
          "description": "자막 시작이 음성보다 300ms 늦음",
          "confidence": 0.94,
          "suggested_fix": "자막 시작 -300ms 조정"
        }
      ],
      "scores": {
        "subtitle_timing": 72,
        "audio_balance": 88,
        "text_quality": 91,
        "structural": 100
      },
      "overall_score": 82,
      "pass": false
    }
```

### 6-4. Refiner Agent (BLUE Team) 상세

```
역할: Critic의 리포트를 받아 CapCutAPI로 드래프트 자동 수정

수정 가능한 항목:
  ┌─────────────────┬──────────────────────────────────┐
  │ 문제 유형        │ 수정 방법                         │
  ├─────────────────┼──────────────────────────────────┤
  │ 자막 타이밍 오류 │ CapCutAPI add_subtitle 재호출     │
  │                 │ (조정된 SRT 파일로 교체)           │
  ├─────────────────┼──────────────────────────────────┤
  │ 오디오 밸런스    │ FFmpeg loudnorm 재처리 후         │
  │                 │ CapCutAPI add_audio 재호출         │
  ├─────────────────┼──────────────────────────────────┤
  │ 자막 오탈자 잔존 │ LLM 셀렉터로 2차 교정 후         │
  │                 │ 교정된 SRT로 드래프트 업데이트     │
  ├─────────────────┼──────────────────────────────────┤
  │ 효과 부족/과다  │ CapCutAPI add_effect 조정         │
  │ (Phase 2)       │ RAG 패턴 기반 추천                │
  └─────────────────┴──────────────────────────────────┘

  핵심: Refiner는 새 드래프트를 처음부터 만들지 않고,
        기존 드래프트를 패치하는 방식 (효율성)
```

### 6-5. Evaluator Agent 상세

```
역할: 수정된 드래프트의 최종 품질 판정

판정 로직:
  1. Critic과 동일한 메트릭으로 재측정
  2. 가중 평균 점수 계산
  3. 85점 이상 → PASS → 마스터에게 전달
  4. 85점 미만 → FAIL → Critic으로 복귀 (다음 반복)
  5. 3회 반복 후에도 미달 → 현재 최고 점수 버전으로
     마스터에게 전달 + "수동 검토 필요" 알림

  n8n 루프 구현:
    → n8n Loop 노드 (Reset Loop 활성화)
    → 최대 반복: 3회 (config에서 조정 가능)
    → 종료 조건: overall_score >= 85 OR iteration >= 3

  비용 영향:
    1회 루프당 LLM 호출: Critic(1) + Refiner(0~1) + Evaluator(1)
    GPT-4o Mini 기준: ~$0.006/루프 × 3회 = ~$0.018/건
    → 기존 비용($0.054/건)에 +33% → 총 $0.072/건
    → 월 12편 기준: $0.86/월 (여전히 $1 미만)
```

### 6-6. Phase별 에이전트 확장 계획

```
Phase 1 (프로토타입 — 3 에이전트):
  Critic:    자막 싱크 + 오디오 밸런스 + 텍스트 품질 + 구조
  Refiner:   SRT 수정 + 오디오 재처리
  Evaluator: 가중 평균 점수 판정

Phase 2 (고도화 — 5+ 에이전트):
  Critic 확장:
    + EngagementAnalyzer: 시청자 집중도 분석 (장면 길이, 패턴)
    + LayoutValidator: 화면 구성 + 정보 계층 검증
  Refiner 확장:
    + EffectOptimizer: RAG 기반 효과 자동 추천/적용

Phase 3 (완전 자동):
  + BrandGuard: 채널 스타일 가이드 일관성 검증
  + 이전 대화의 10명 에이전트 풀 가동 가능
    (필요 시 에이전트 수를 config에서 조절)
```

---

## 7. 구현 로드맵

### Phase 1: 프로토타입 (2주)

```
Week 1: 전처리 + CapCutAPI 연동
  ☐ CapCutAPI 설치 + MCP 서버 구동 테스트
  ☐ FFmpeg 오디오 정규화 스크립트 작성
  ☐ Whisper API 연동 + SRT 생성 테스트
  ☐ LLM 셀렉터 자막 교정 프롬프트 최적화
  ☐ CapCutAPI로 드래프트 생성 테스트 (add_video/audio/subtitle)
  ☐ ★ draft_info.json 파서 구현 (capcut-export 참조)
  ☐ ★ draft_info.json → FFmpeg 1440p/60fps 렌더링 파이프라인
  ☐ 샘플 1세트 (폴더 1/DB생성)로 엔드투엔드 테스트

Week 2: n8n 통합 + 워커 웹 + 품질 루프 기초
  ☐ 워커 웹 대화형 영상 편집 페이지 (9단계 UX)
  ☐ n8n 워크플로우 구성 (웹 업로드 → 파이프라인 자동 트리거)
  ☐ Critic-Refiner-Evaluator 3에이전트 기초 구현
  ☐ 나머지 4세트로 파이프라인 검증
  ☐ 자동 생성 드래프트 vs 수동 편집 품질 비교
  ☐ 텔레그램 알림 + PostgreSQL 편집 이력 연동

Week 3: 최종 테스트 + 문서 체계 통합
  ☐ 통합 테스트 (4개 시나리오: 단일/다중/에러/보안)
  ☐ 품질 테스트 (5세트, 자동 vs 수동 비교)
  ☐ 미달 항목 수정
  ☐ ★ 문서 이동: bots/video/docs/ → docs/video/ (프로젝트 문서 체계 통합)
  ☐ 최종 확인 + 문서 정리
```

### Phase 2: 고도화 (4주, Phase 1 안정화 후)

```
  ☐ draft_info.json → FFmpeg 렌더링 파이프라인 고도화
      (효과/전환까지 FFmpeg 필터 체인으로 재현)
  ☐ RAG 편집 패턴 학습 (기존 5세트 분석)
  ☐ CapCutAPI add_effect → RAG 기반 효과 자동 추천
  ☐ 품질 검증 루프 고도화 (EngagementAnalyzer + LayoutValidator 추가)
  ☐ Whisper 로컬 실행 옵션 (비용 $0 달성)
  ☐ 품질 점수 이력 대시보드 (PostgreSQL → 텔레그램 주간 리포트)
  ☐ ★ 더백클래스 LMS 영상 구조 학습
      → the100class.flutterflow.app (FlutterFlow 기반 LMS)
      → 기존 강의 영상의 메타데이터, 포맷, 카테고리 구조 분석
      → 편집 자동화 파이프라인과 LMS 콘텐츠 구조 매핑
```

### Phase 3: Case 2 확장 (기획 보류, 설계만)

```
  ☐ TTS API 연동 (AudioSource 인터페이스)
  ☐ 이미지/슬라이드 자동 생성 (VideoSource 인터페이스)
  ☐ 대본 → 장면 분해 (Claude 활용)
  ☐ 10명 에이전트 풀 가동 (BrandGuard 등 전체 RED/BLUE Team)
  ☐ Shotstack API 대량 렌더링 (선택적)
  ☐ ★ 더백클래스 LMS 자동 업데이트 연동
      → 편집 완료 → 더백클래스에 자동 업로드
      → FlutterFlow API 또는 Firebase/Supabase 직접 연동
      → 강의 메타데이터(제목, 설명, 카테고리, 썸네일) 자동 생성
      → 워커 웹에서 "LMS 발행" 버튼 추가
```

---

## 8. 리스크 및 대응

```
┌──────────────────────┬─────────────────────────────────────┐
│ 리스크                │ 대응                                │
├──────────────────────┼─────────────────────────────────────┤
│ Whisper 한글 정확도   │ IT 전문용어 사전 + LLM 셀렉터 교정  │
│ 부족 시               │ 으로 2단계 보정                      │
├──────────────────────┼─────────────────────────────────────┤
│ CapCutAPI 호환성      │ 오픈소스 활발 개발 중 (Apache 2.0)   │
│ CapCut 버전 업데이트  │ 드래프트 포맷 변경 시 API 업데이트   │
│ 시 깨질 수 있음       │ + FFmpeg 직접 렌더링 폴백 경로 유지  │
├──────────────────────┼─────────────────────────────────────┤
│ CapCut 무료 플랜     │ ★ 해결됨: CapCut에서 Export 안 함    │
│ 1080p/30fps 제한     │ 편집 상태 유지 → FFmpeg 1440p/60fps  │
│                      │ 렌더링으로 제한 완전 우회             │
├──────────────────────┼─────────────────────────────────────┤
│ draft_info.json →    │ capcut-export (npm) 오픈소스 활용     │
│ FFmpeg 변환 정확도   │ 기본 편집(클립+오디오+자막)은 검증됨  │
│                      │ 복잡한 효과는 Phase 2에서 고도화      │
├──────────────────────┼─────────────────────────────────────┤
│ 품질 루프가 85점에    │ 3회 반복 후 최고 점수 버전으로 전달  │
│ 도달 못할 경우        │ + "수동 검토 필요" 마스터 알림        │
├──────────────────────┼─────────────────────────────────────┤
│ 나레이션-영상 싱크    │ Whisper 타임스탬프 기반 자동 컷팅    │
│ 불일치 시             │ + CapCut에서 수동 미세 조정          │
├──────────────────────┼─────────────────────────────────────┤
│ OpenAI API 장애 시    │ Whisper 로컬 폴백 (FFmpeg 8.0 내장)  │
│                      │ LLM 셀렉터 자동 폴백                 │
│                      │ (OpenAI → Gemini → Claude 순차 전환)  │
├──────────────────────┼─────────────────────────────────────┤
│ 품질 루프 비용 증가   │ GPT-4o Mini 기준 루프당 $0.006       │
│                      │ 3회 × 12편/월 = +$0.22/월 (무시 가능)│
└──────────────────────┴─────────────────────────────────────┘
```
