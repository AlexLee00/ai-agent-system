# STT / 이미지 생성 브라우저 Fallback 설계서

> 작성: Codex
> 작성일: 2026-04-03
> 근거:
> - retired gateway browser / browser-login / chrome extension relay 문서
> - OpenAI Speech-to-Text / Image Generation 공식 문서
> - SeaArt/Web2Labs Studio 계열 browser orchestration 사례
> 상태: 설계 단계

---

## 1. 한 줄 결론

STT와 이미지 생성은 `브라우저를 메인 처리 엔진`으로 쓰기보다,
`전용 API/전용 엔진을 메인`으로 두고 `Hub + Chrome MCP 브라우저 자동화`를 fallback/rescue lane으로 두는 것이 가장 안정적이다.

즉:

```text
Primary:
  STT -> 전용 STT API 또는 로컬 STT 엔진
  Image -> 전용 이미지 생성 API

Fallback:
  Hub browser / Chrome relay / MCP
  -> 로그인, 업로드, 생성, 결과 다운로드, 로컬 저장
```

---

## 2. 왜 브라우저 메인이 아니어야 하나

### 2-1. STT

- Whisper/STT는 파일 업로드, 길이 제한, 응답 시간, 파일 형식 제약이 크다
- 브라우저 UI는 다음 변수에 취약하다
  - 업로드 컴포넌트 변경
  - 로그인 만료
  - anti-bot
  - 생성 후 결과 DOM 구조 변경
- 따라서 브라우저는 `업로드/다운로드 자동화`엔 맞지만, 메인 STT 백엔드로는 불안정하다

### 2-2. 이미지 생성

- 이미지 생성도 브라우저에서는 보통
  - 프롬프트 입력
  - 생성 대기
  - 이미지 다운로드
흐름으로 진행되며, UI 변경의 영향을 크게 받는다
- 특히 대량 생성/자동 발행에서는 API가 더 예측 가능하다

---

## 3. 사례 분석 요약

### Retired gateway 공식 브라우저 도구

- Retired gateway 계열은 browser tool, browser login, Chrome extension relay를 공식 지원한다
- 강점:
  - 기존 Chrome 탭 제어
  - 스냅샷/타이핑/클릭/업로드
  - 로그인 세션 활용
- 공식 문서가 암시하는 기본 용도는 `웹 작업 자동화`이지, 미디어 생성 자체의 전용 처리기는 아니다

### SeaArt x browser orchestration

- 이미지 생성 사례는 `브라우저를 직접 누르는 것`보다 `전용 이미지 skill`에 가깝다
- 즉 browser orchestration layer가 조율을 맡고, 실제 생성은 전용 이미지 서비스가 수행한다

### Web2Labs Studio x browser orchestration

- STT/영상 편집 사례도 핵심은 `전용 미디어 파이프라인 skill`
- 브라우저는 로그인/업로드/결과 수집 표면으로 해석하는 것이 자연스럽다

---

## 4. 권장 아키텍처

```text
Agent / Workflow
  -> runtime selector
  -> media router

media router:
  Primary direct lane
    - video/stt -> direct STT
    - blog/image -> direct image api

  Browser fallback lane
    - video/stt-browser
    - blog/image-browser

browser fallback lane:
  Hub browser profile
  -> open target site
  -> ensure login
  -> upload file or paste prompt
  -> wait for result
  -> download / extract output
  -> save local path
  -> trace result
```

---

## 5. 팀별 적용 방향

### 5-1. video / STT

현재 메인:

- `video/stt`
- direct OpenAI Whisper 계열

추가 fallback:

- `video/stt-browser`
- 목적:
  - direct STT 실패 시
  - 일시적 API 장애 시
  - 사람이 수동으로 하던 웹 전사 툴 사용을 자동화할 때

브라우저 fallback 기본 흐름:

1. Hub browser profile 선택
2. 대상 전사 웹 툴 접속
3. 로그인 확인
4. 오디오 업로드
5. 언어/옵션 지정
6. 전사 완료 대기
7. 텍스트/SRT 다운로드
8. 로컬 저장

### 5-2. blog / image

현재 메인:

- `blog/image`
- direct image API

추가 fallback:

- `blog/image-browser`
- 목적:
  - direct image API 실패 시
  - 무료/크레딧 기반 웹 이미지 툴 사용 시
  - 특정 스타일 전용 툴이 더 나을 때

브라우저 fallback 기본 흐름:

1. Hub browser profile 선택
2. 대상 이미지 생성 웹 툴 접속
3. 로그인 확인
4. 프롬프트 입력
5. 비율/스타일 선택
6. 생성 완료 대기
7. 첫 결과 다운로드
8. 로컬 저장

---

## 6. 반드시 남겨야 할 trace

- `team`
- `purpose`
- `execution_mode`
  - `direct`
  - `browser_mcp`
- `browser_profile`
- `target_site`
- `attempt`
- `success`
- `duration_ms`
- `download_path`
- `error_stage`
  - `login`
  - `upload`
  - `generate`
  - `download`

---

## 7. 금지 범위

다음은 브라우저 fallback으로도 자동화하지 않는 것이 좋다.

- 결제/카드 입력 자동화
- 2차 인증을 우회하는 로그인 자동화
- 약관 위반 가능성이 높은 대량 생성
- 비공식 DOM scraping에 과도하게 의존하는 상시 운영

---

## 8. 구현 우선순위

### 1차

- `video/stt-browser` profile 설계
- `blog/image-browser` profile 설계
- Hub runtime profile에 browser fallback purpose 추가

### 2차

- browser task runner 추가
- Hub browser 명령 래퍼 추가
- download/save/timeout/retry 표준화

### 3차

- direct 실패 시 browser fallback 자동 진입
- trace 비교
- 성공률/평균 시간 기준 평가

---

## 9. 최종 결론

브라우저 자동화는 STT와 이미지 생성의 `메인 백엔드`가 아니라,
`공식 API/전용 엔진이 실패했을 때 복구하는 보조 레이어`로 두는 것이 가장 현실적이다.

우리 시스템 기준 최선은:

- `STT = direct or local engine`
- `Image = direct image api`
- `Browser = fallback / rescue / no-api site automation`
