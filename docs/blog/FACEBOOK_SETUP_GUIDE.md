# 페이스북 자동 발행 설정 가이드

> 마스터 작업 항목 — Facebook Page access_token + Page ID 발급
> Phase 1 요구사항 / 2026-04-19

---

## 사전 조건

- Facebook 계정 (개인)
- Facebook Page 생성 완료 (비즈니스 페이지)
- Meta Developer 앱 생성 완료 (INSTAGRAM_SETUP_GUIDE.md Step 1 참조)

---

## Step 1: Facebook Page 생성

이미 Page가 있다면 Step 2로 이동.

1. https://www.facebook.com/pages/create 접속
2. Page 유형: "비즈니스 또는 브랜드" 선택
3. Page 이름, 카테고리 (스터디 카페 / 교육) 입력
4. Page 생성 완료

---

## Step 2: Meta Developer 앱에 Facebook Login 추가

1. https://developers.facebook.com → 내 앱 → 기존 앱 선택
2. "제품 추가" → **"Facebook 로그인"** → 설정
3. "웹" 선택 → 사이트 URL: `https://localhost`
4. 저장

---

## Step 3: 필요 권한 추가

앱 대시보드 → "App Review" → "권한 및 기능":

- `pages_manage_posts` — 페이지 게시글 작성
- `pages_read_engagement` — 참여도 읽기
- `pages_show_list` — 페이지 목록 조회
- `publish_pages` — 페이지 발행 (구버전 호환)

> 일부 권한은 앱 검토(App Review) 승인이 필요합니다.
> 개발 모드에서는 앱 소유자 계정에 대해서만 동작합니다.

---

## Step 4: Page Access Token 발급

### 4-1. 사용자 액세스 토큰 획득 (Graph API Explorer)

1. https://developers.facebook.com/tools/explorer 접속
2. 앱 선택 → 권한에서 `pages_manage_posts`, `pages_read_engagement` 체크
3. "액세스 토큰 생성" 클릭
4. 사용자 액세스 토큰 복사

### 4-2. Page Access Token 조회

```bash
curl "https://graph.facebook.com/v21.0/me/accounts?\
  access_token={사용자_액세스_토큰}"
```

응답 예시:
```json
{
  "data": [
    {
      "access_token": "PAGE_ACCESS_TOKEN_HERE",
      "category": "Education",
      "id": "123456789",
      "name": "내 스터디카페 페이지"
    }
  ]
}
```

`access_token` = **Page Access Token** (장기 토큰)
`id` = **Page ID**

### 4-3. 장기 토큰 확인 (Page Access Token은 기본 장기)

Page Access Token은 대부분 무기한(영구)입니다.
만료 여부 확인:
```bash
curl "https://graph.facebook.com/v21.0/debug_token?\
  input_token={PAGE_ACCESS_TOKEN}&\
  access_token={APP_ID}|{APP_SECRET}"
```

---

## Step 5: secrets-store.json 등록

`bots/hub/secrets-store.json` 에 다음 추가 (절대 git 커밋 금지):

```json
{
  "blog": {
    "facebook": {
      "page_id": "발급된_Page_ID",
      "page_access_token": "발급된_Page_Access_Token"
    }
  }
}
```

환경변수로도 설정 가능:
```bash
launchctl setenv FB_PAGE_ID "..."
launchctl setenv FB_PAGE_ACCESS_TOKEN "..."
```

---

## Step 6: 발행 테스트

```bash
cd /Users/alexlee/projects/ai-agent-system

# 드라이런 (실제 발행 없음)
npx tsx bots/blog/scripts/publish-facebook-post.ts --dry-run

# 실제 테스트 발행
npx tsx bots/blog/scripts/publish-facebook-post.ts --test
```

---

## 자동 발행 launchd

`bots/blog/launchd/ai.blog.facebook-publish.plist` — 매일 10:00 자동 실행

수동 테스트:
```bash
npx tsx bots/blog/scripts/auto-facebook-publish.ts --dry-run
```

---

## Facebook Graph API 발행 방식

### 텍스트 + 링크 포스트

```bash
curl -X POST "https://graph.facebook.com/v21.0/{PAGE_ID}/feed" \
  -d "message=포스팅 내용..." \
  -d "link=https://blog.naver.com/..." \
  -d "access_token={PAGE_ACCESS_TOKEN}"
```

### 이미지 포함 포스트

```bash
# 1. 이미지 업로드 (비공개)
curl -X POST "https://graph.facebook.com/v21.0/{PAGE_ID}/photos" \
  -F "source=@/path/to/image.jpg" \
  -F "published=false" \
  -F "access_token={PAGE_ACCESS_TOKEN}"

# 2. 이미지 ID로 게시글 발행
curl -X POST "https://graph.facebook.com/v21.0/{PAGE_ID}/feed" \
  -d "message=내용..." \
  -d "attached_media[0]={'media_fbid':'IMAGE_ID'}" \
  -d "access_token={PAGE_ACCESS_TOKEN}"
```

---

## 검증 체크리스트

- [ ] Facebook Page 생성/확인 완료
- [ ] Meta Developer 앱에 `pages_manage_posts` 권한 추가
- [ ] Page Access Token 발급
- [ ] Page ID 확인
- [ ] secrets-store.json 등록
- [ ] `publish-facebook-post.ts --dry-run` 실행 성공

---

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `OAuthException: (#200) Requires manage_pages permission` | 권한 미승인 | App Review 또는 개발 모드 확인 |
| `Error: Page not found` | Page ID 오류 | `/me/accounts` API로 재확인 |
| `SpamError: link blocked` | 링크 스팸 감지 | 네이버 블로그 URL 사전 등록 필요 |
| `Rate limit reached` | API 호출 한도 초과 | 발행 빈도 조정 (하루 1~3개) |

---

## Meaningful Interaction 주의사항

페이스북 2026 알고리즘은 "Meaningful Interaction"을 우선합니다:
- 일방적 홍보 글보다 **질문형, 토론 유도** 콘텐츠가 노출 우선
- Reels 형식이 일반 포스트보다 도달 높음
- 댓글에 반응하면 알고리즘 점수 상승

> 참고: Meta Graph API https://developers.facebook.com/docs/graph-api
