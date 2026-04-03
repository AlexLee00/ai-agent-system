# 로컬 이미지 생성 도입 설계서

> 작성: Codex
> 작성일: 2026-04-03
> 대상: 블로그팀 이미지 생성
> 우선순위: 품질 우선, 속도 후순위
> 상태: 설계 단계

---

## 1. 한 줄 결론

블로그팀 이미지 생성은 `OpenAI gpt-image-1 메인` 구조를 유지할 이유가 약하다.

품질 우선 기준에서는:

```text
ComfyUI local image generation
  -> Gemini / Nano Banana fallback
  -> OpenAI gpt-image-1 last-resort fallback
```

이 구조가 가장 합리적이다.

---

## 2. 왜 ComfyUI인가

### 장점

- 품질 중심 워크플로우 구성에 강함
- 모델, LoRA, 업스케일, 후처리 조합 자유도가 높음
- 블로그 썸네일, 인스타 카드, 브랜드 일관성 유지에 유리함
- 브라우저 UI 자동화보다 안정적이고 재현 가능함
- OpenAI 이미지 비용을 크게 줄일 수 있음

### 단점

- 설치와 워크플로우 구성이 복잡함
- 초기 세팅 시간이 필요함
- 로컬 자원 사용량이 큼

하지만 현재 목표가 `속도`가 아니라 `품질`이므로, 단점보다 장점이 더 크다.

---

## 3. 권장 아키텍처

```text
blog img-gen
  -> local image router

local image router:
  1. ComfyUI render
  2. local post-process / upscale
  3. save local file

fallback chain:
  4. Gemini image
  5. OpenAI gpt-image-1
```

---

## 4. 적용 대상

### 4-1. 대표 썸네일

- 블로그 대표 이미지
- 16:9 비율
- 가장 품질 민감
- ComfyUI 메인 사용 권장

### 4-2. 인스타 카드

- 1:1 비율
- 요약 카드형
- 고정 스타일 템플릿과 잘 맞음
- ComfyUI 또는 Gemini fallback

### 4-3. 중간 삽입 이미지

- 본문 보조 이미지
- 품질은 중요하지만 대표 이미지보다 덜 민감
- ComfyUI 우선, 필요 시 Gemini

---

## 5. 운영 전략

### 5-1. 메인 경로

- `blog/image-local`
- ComfyUI workflow 호출
- 출력 파일을 즉시 로컬에 저장

### 5-2. 1차 폴백

- `blog/image-free`
- Gemini / Nano Banana

### 5-3. 2차 폴백

- `blog/image-paid`
- OpenAI gpt-image-1

---

## 6. 요구 기능

### ComfyUI 래퍼가 해야 할 일

- prompt 입력
- aspect ratio 선택
- style preset 선택
- output file path 지정
- 생성 완료 대기
- 결과 파일 경로 반환

### img-gen이 해야 할 일

- local -> free -> paid 순서 실행
- 실패 단계 기록
- 결과 source 명시
- trace/log 저장

---

## 7. 품질 기준

다음은 로컬 이미지 생성 품질 기준이다.

- 텍스트가 이미지 안에 직접 들어가지 않을 것
- 블로그 카테고리별 시각적 톤이 안정적일 것
- 동일 프롬프트 계열에서 스타일 일관성이 있을 것
- 인스타 카드에서 너무 난잡하지 않을 것
- 대표 썸네일이 클릭 유도형이되 자극적이지 않을 것

---

## 8. trace 항목

- `team=blog`
- `purpose=image-local`
- `execution_mode=local_image`
- `engine=comfyui`
- `workflow_id`
- `output_path`
- `duration_ms`
- `fallback_stage`
- `success`

---

## 9. 위험과 대응

### 위험

- ComfyUI 설치 복잡도
- 로컬 자원 부족
- 워크플로우 파일 관리 난이도

### 대응

- 처음엔 블로그 대표 이미지 한 경로만 붙인다
- fallback은 기존 Gemini/OpenAI 유지
- 성능보다 품질 평가를 우선한다

---

## 10. 구현 우선순위

### 1차

- ComfyUI 런타임 준비
- blog/image-local runtime profile 추가
- local image client 추가

### 2차

- img-gen.js를 `local -> free -> paid`로 전환
- 대표 썸네일 먼저 적용

### 3차

- 인스타 카드까지 확대
- style preset 분리
- category별 workflow 분화

---

## 11. 최종 결론

품질 우선 전략에서는 브라우저 무료 생성보다 `ComfyUI 로컬 생성`이 더 맞다.

따라서 블로그팀 이미지 생성은:

- `ComfyUI 메인`
- `Gemini 무료 폴백`
- `OpenAI 마지막 예외`

로 재구성하는 것이 가장 합리적이다.
