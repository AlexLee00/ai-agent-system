# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-20 (2차 세션)
> 담당: 메티 (claude.ai Opus)
> 상태: 과제 2 FFmpeg 전처리 완료 + Whisper STT(과제 3) 대기

---

## 이번 세션에서 완료한 것

### 1. 더백클래스 LMS 관리자 패널 접속 성공
- URL: the100class.flutterflow.app/adminLectures
- 제이가 직접 로그인 완료 (비밀번호 관리자 팝업 이슈 해결)
- 강의 관리 페이지 구조 확인 완료

### 2. LMS 강의 구조 파악 (스크린샷 3장 분석)

```
좌측 메뉴:
  회원 관리 / 약관 관리 / 강의 관리 / FAQ 관리 / 멤버십 관리 / 기타

강의 테이블 컬럼:
  순번 | 생성일시 | 수정일시 | 카테고리 | 제목 | 부제 | 영상 | 시청수 | 수강수 | 공개 | 관리 | 신규

카테고리 3개 확인:
  ① 인스타1st SNS 앱 (순번 1~36) — 인스타그램 클론 앱 개발
     1. 36. 프로필 편집: 액션 설계
     2. 35. 프로필 편집 페이지
     ...
     30. 7. 이용약관: 관리자 기능
     ...
     36. 1. 커스텀 NavBar (인스타그램 스타일)
     37. 0. 프로젝트 셋업 (FlutterFlow 프로젝트)

  ② 컴팩트기초(서버) (순번 38~46)
     38. 부록. 데스크탑 앱 (실제 핸드폰 또는)
     39. 부록. 데스크탑 앱 (실제 핸드폰 또는)
     40. 7. 데이터베이스 4대 규칙
     41. 6. 데이터베이스 4대 규칙
     42. 5. 데이터베이스 4대 규칙
     43. 4. 데이터베이스 4대 규칙
     44. 3. DB구조 (SQL vs NoSQL)
     45. 2. 인증 Authentication 회원가입
     46. 1. 프로젝트 셋업 (FlutterFlow 프로)

  ③ 컴팩트기초(로컬) (순번 47~56)
     47. 10. 로컬 미니 앱 [컴팩트 기초(로)]
     48. 9. 데이터 전달 Parameter
     49. 8. 동적데이터
     50. 7. 로컬변수 Component
     51. 6. 로컬변수 Page
     52. 5. 로컬변수 App
     53. 4. Actions
     54. 3. 화면 UI 개념잡기
     55. 2. FlutterFlow 둘러보기
     56. 1. 오리엔테이션

총 56개 강의 (역순 정렬 — 최신이 위)
공개 상태: 공개(초록) / 비공개(회색) 혼재
관리 버튼: 수정(파랑) + 삭제(빨강) 각 강의별
우상단: "신규 강의 업로드" 버튼 (초록)
```

### 3. 유튜브 플레이리스트 확인
- 채널: AI·노코드 THE100
- 플레이리스트: "Flutterflow 중급" — 105개 동영상, 조회수 60,331회
- 1~4편: Action-Navigation
- 5~9편: Firebase (Setup, Auth, Password Reset, SHA-1)
- 일부 "회원 전용" 표시 → LMS 유료 콘텐츠

### 4. 문서 기준값/프롬프트 정합화
- `bots/video/docs/CLAUDE.md`
  - YouTube 권장 렌더링 확정값(24M / 48kHz / 384kbps / faststart) 반영
- `bots/video/docs/video-team-design.md`
  - `config 구조` 섹션을 YouTube 공식 권장 기반 값으로 갱신
- `bots/video/docs/video-team-tasks.md`
  - FFmpeg/렌더링 과제 프롬프트의 하드코딩을 줄이고 config/CLAUDE.md 참조 구조로 정리
- `bots/video/samples/ANALYSIS.md`
  - 초기 분석값(섹션 6~7)과 최종 확정값(섹션 8)을 구분하도록 정리

---

## 다음 세션에서 해야 할 것

### 1. LMS 영상 상세 구조 학습 (우선)
- 개별 강의 클릭 → 영상 URL, 메타데이터 필드 확인
- "수정" 버튼 클릭 → 편집 폼 구조 파악 (어떤 필드가 있는지)
- "신규 강의 업로드" 버튼 → 업로드 폼 구조 파악
- 영상 호스팅 방식 확인 (직접 업로드 vs 유튜브 임베드 vs Firebase Storage)
- 이 정보를 video-team-design.md 섹션 8에 반영

### 2. 문서 반영 상태 확인
- `bots/video/docs/`에 핵심 문서 4개가 이미 배치됨
  - VIDEO_HANDOFF.md
  - video-automation-tech-plan.md
  - video-team-design.md
  - video-team-tasks.md
- `bots/video/docs/CLAUDE.md`
  - Claude Code용 구현 규칙 문서
  - YouTube 렌더링 확정값, 문서 참조 순서, 절대 규칙 포함
- `SESSION_HANDOFF_VIDEO.md`는 세션 로그 성격의 보조 문서
- `bots/video/samples/ANALYSIS.md`
  - raw/narration/edited 샘플의 ffprobe 분석 결과
  - config와 출력 스펙 확정의 근거 문서

### 3. Claude Code / 코덱 다음 작업
- 과제 2 FFmpeg 전처리 완료 상태 확인
- 다음은 `video-team-tasks.md` 과제 3 프롬프트 → Whisper STT 구현
- 과제별 단위 테스트 통과 후 순차 진행
- 각 과제 종료 시 문서 업데이트 + 커밋 + push까지 수행
- 코덱 또는 Claude Code 모두 시작 전에 `CLAUDE.md → VIDEO_HANDOFF.md → video-team-design.md → samples/ANALYSIS.md → video-team-tasks.md` 순서를 먼저 읽는다.
- 세션 마감 직전에는 `VIDEO_HANDOFF.md / SESSION_HANDOFF_VIDEO.md / 전사 SESSION_HANDOFF.md` 반영 여부를 다시 확인한다.

### 4. 역할 경계 유지
- Claude는 bots/video 폴더 문서를 읽고 프롬프트/설계 방향을 정리하는 역할
- 실제 코드 업데이트는 코덱(Codex) 또는 Claude Code가 수행
- 구현 세션에서는 파일 수정 후 반드시 문서에 현재 상태를 반영

---

## 프로젝트 현재 상태

```
ai-agent-system/bots/video/
├─ config/
│   └─ video-config.yaml            ✅ 생성 완료
├─ context/
│   └─ IDENTITY.md                  ✅ 생성 완료
├─ docs/
│   ├─ SESSION_HANDOFF_VIDEO.md     ✅ 이 파일
│   ├─ VIDEO_HANDOFF.md             ✅ 인수인계 허브
│   ├─ CLAUDE.md                    ✅ 구현 규칙 + 렌더링 확정값
│   ├─ video-automation-tech-plan.md✅ 기술 구현 방안
│   ├─ video-team-design.md         ✅ 설계 문서
│   └─ video-team-tasks.md          ✅ 소과제 문서
├─ lib/
│   └─ ffmpeg-preprocess.js         ✅ 과제 2 구현 완료
├─ migrations/
│   └─ 001-video-schema.sql         ✅ 생성 완료
├─ scripts/
│   └─ test-preprocess.js           ✅ 과제 2 테스트 스크립트
├─ samples/                         ← 로컬 fixture 데이터 (raw/narration/edited + ANALYSIS.md)
├─ temp/                            ✅ 생성 완료
├─ exports/                         ✅ 생성 완료
└─ src/
   └─ index.js                      ✅ 생성 완료
```

## 크롬 탭 상태

```
tabId 284978451: "Flutterflow 중급 - YouTube"
tabId 284978582: "AI&NoCode 프리미엄 강의" (adminLectures — 로그인됨)
```

## 핵심 결정사항 (변경 없음)

```
1. CapCut 무료 + FFmpeg 렌더링 (Pro 불필요)
2. ai-agent-system/bots/video/ 에 통합
3. 개발 중 문서: bots/video/docs/ → 안정화 후 docs/video/
4. 대화형 UX 9단계 (클로드 프롬프트 형태)
5. 다중 파일 업로드 + 영상-음성 자동 매칭
6. 단계적 구현 + 단위 테스트 필수
7. 더백클래스 LMS 연동은 Phase 2+
8. RED/BLUE Team = Critic-Refiner-Evaluator 3에이전트
```

## 현재까지 정리된 구현 기준

```
문서 기준으로 현재 확정된 것:
1. 렌더링 목표: 2560x1440 / 60fps / H.264 High Profile / 24M / +faststart / bt709
2. 오디오 목표: AAC / 48kHz / stereo / 384kbps / -14 LUFS / -1 dBTP
3. 과제 프롬프트는 하드코딩보다 config/video-config.yaml 참조를 우선
4. samples/ANALYSIS.md는 초기값과 최종값을 분리해 해석

구현 완료:
- bots/video/context/IDENTITY.md
- bots/video/config/video-config.yaml
- bots/video/migrations/001-video-schema.sql
- bots/video/src/index.js
- public.video_edits 테이블 생성/조회 검증
- bots/video/lib/ffmpeg-preprocess.js
- bots/video/scripts/test-preprocess.js
- 샘플 1세트 전처리 검증
  - removeAudio / normalizeAudio / syncVideoAudio / preprocess 통합 통과
  - 오디오 48kHz stereo AAC 확인
  - LUFS -14.9 확인

아직 구현되지 않은 것:
- Whisper STT / 자막 교정 / CapCut / 렌더 파이프라인
```
