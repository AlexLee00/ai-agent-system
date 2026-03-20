# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-20 (2차 세션)
> 담당: 메티 (claude.ai Opus)
> 상태: 기획 완료 + LMS 구조 학습 진행 중

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

---

## 다음 세션에서 해야 할 것

### 1. LMS 영상 상세 구조 학습 (우선)
- 개별 강의 클릭 → 영상 URL, 메타데이터 필드 확인
- "수정" 버튼 클릭 → 편집 폼 구조 파악 (어떤 필드가 있는지)
- "신규 강의 업로드" 버튼 → 업로드 폼 구조 파악
- 영상 호스팅 방식 확인 (직접 업로드 vs 유튜브 임베드 vs Firebase Storage)
- 이 정보를 video-team-design.md 섹션 8에 반영

### 2. MD 파일 3개 배치 (제이가 다운로드 후)
- claude.ai에서 다운로드:
  video-automation-tech-plan.md (950줄)
  video-team-design.md (719줄)
  video-team-tasks.md (726줄)
- 터미널 실행: bash bots/video/scripts/setup-video-docs.sh
- 또는 수동으로 bots/video/docs/ 에 복사

### 3. Claude Code 과제 1 실행 (MD 배치 후)
- video-team-tasks.md 과제 1 프롬프트 → 스캐폴딩
- 과제별 단위 테스트 통과 후 순차 진행

---

## 프로젝트 현재 상태

```
ai-agent-system/bots/video/
├─ config/                          ← 빈 폴더
├─ context/                         ← 빈 폴더
├─ docs/
│   ├─ SESSION_HANDOFF_VIDEO.md     ✅ 이 파일
│   └─ VIDEO_HANDOFF.md             ✅ 인수인계 허브
│   (나머지 3개 MD: 제이 다운로드 후 배치 필요)
├─ lib/                             ← 빈 폴더
├─ migrations/                      ← 빈 폴더
├─ scripts/
│   └─ setup-video-docs.sh          ✅ MD 배치 스크립트
└─ src/                             ← 빈 폴더
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
