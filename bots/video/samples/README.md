# 학습용 영상 샘플

> 더백클래스 LMS + FlutterFlow 유튜브 채널 영상 학습용

## 폴더 구조

```
samples/
├─ raw/            — 원본 영상 (.mp4)
├─ narration/      — 나레이션 파일 (.m4a, .mp3)
├─ edited/         — 편집 완료본 (참고용)
└─ README.md       — 이 파일
```

## 용도

- 영상 편집 자동화 파이프라인 개발 시 학습/테스트 데이터
- ffprobe 분석, Whisper STT 테스트, CapCut 드래프트 생성 테스트
- 기존 편집 패턴 학습 (RAG 임베딩용)

## 소스

- 더백클래스 LMS (the100class.flutterflow.app) 강의 영상
- 유튜브 "AI·노코드 THE100" 채널 FlutterFlow 중급 플레이리스트

## 주의

- ★ 영상 파일은 git에 포함하지 않음 (.gitignore)
- 로컬 개발 환경에서만 사용
