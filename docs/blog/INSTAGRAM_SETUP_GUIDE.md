# 인스타그램 자동 발행 설정 가이드

> 마스터 작업 항목 — Meta Developer 등록 + access_token 발급
> Phase 1 요구사항 / 2026-04-19

---

## 사전 조건

- Facebook 비즈니스 계정 (개인 계정 불가)
- Instagram 프로페셔널 계정 (비즈니스 또는 크리에이터)
- Facebook Page와 Instagram 계정 연동 완료

---

## Step 1: Facebook Developer 앱 생성

1. https://developers.facebook.com 접속 → 로그인
2. 상단 "내 앱" → "앱 만들기"
3. 앱 유형: **"비즈니스"** 선택
4. 앱 이름: `team-jay-blog-publisher` (임의 설정)
5. 앱 생성 후 대시보드 진입

---

## Step 2: Instagram Graph API 제품 추가

1. 앱 대시보드 → "제품 추가" → **"Instagram Graph API"** → 설정
2. "Instagram 기본 화면" 추가
3. "권한" 탭에서 다음 권한 요청:
   - `instagram_basic`
   - `instagram_content_publish`
   - `instagram_manage_comments`
   - `pages_read_engagement`

---

## Step 3: 비즈니스 계정 연결

1. 앱 설정 → "비즈니스" → Meta 비즈니스 계정 연결
2. Instagram 비즈니스 계정을 Facebook Page에 연동:
   - Facebook Page 설정 → "Instagram" → 계정 연결

---

## Step 4: Access Token 발급 (60일 만료)

### 4-1. 단기 사용자 토큰 획득

```
https://www.facebook.com/v21.0/dialog/oauth?
  client_id={앱_ID}&
  redirect_uri=https://localhost&
  scope=instagram_basic,instagram_content_publish,pages_read_engagement&
  response_type=token
```

브라우저에서 위 URL 접속 → 승인 → URL에서 `access_token` 복사

### 4-2. 장기 토큰으로 교환 (60일)

```bash
curl "https://graph.facebook.com/v21.0/oauth/access_token?\
  grant_type=fb_exchange_token&\
  client_id={앱_ID}&\
  client_secret={앱_시크릿}&\
  fb_exchange_token={단기_토큰}"
```

응답의 `access_token` 값 복사.

---

## Step 5: ig_user_id 조회

```bash
curl "https://graph.facebook.com/v21.0/me/accounts?\
  access_token={장기_토큰}"
```

응답에서 Page ID 확인 후:

```bash
curl "https://graph.facebook.com/v21.0/{PAGE_ID}?\
  fields=instagram_business_account&\
  access_token={장기_토큰}"
```

응답의 `instagram_business_account.id` 값 = `ig_user_id`

---

## Step 6: secrets-store.json 등록

`bots/hub/secrets-store.json` 에 다음 추가 (절대 git 커밋 금지):

```json
{
  "blog": {
    "instagram": {
      "ig_user_id": "발급된_ig_user_id",
      "access_token": "발급된_장기_토큰",
      "page_id": "연결된_Facebook_Page_ID"
    }
  }
}
```

환경변수로도 설정 가능:
```bash
launchctl setenv IG_USER_ID "..."
launchctl setenv IG_ACCESS_TOKEN "..."
```

---

## Step 7: 토큰 갱신 자동화 확인

`ai.blog.instagram-token-health` launchd가 매일 토큰 만료를 체크합니다.
만료 7일 전 Telegram 경고 알림이 발송됩니다.

수동 갱신 스크립트:
```bash
cd /Users/alexlee/projects/ai-agent-system
npx tsx bots/blog/scripts/refresh-instagram-token.ts
```

---

## 검증 체크리스트

- [ ] https://developers.facebook.com 에서 앱 생성 완료
- [ ] `instagram_content_publish` 권한 승인
- [ ] 장기 access_token (60일) 발급
- [ ] `ig_user_id` 확인
- [ ] secrets-store.json 등록
- [ ] `npx tsx bots/blog/scripts/check-instagram-readiness.ts` 실행 → 모두 ✅

---

## 자동 발행 launchd

`bots/blog/launchd/ai.blog.instagram-publish.plist` — 매일 09:00 자동 실행

수동 테스트:
```bash
npx tsx bots/blog/scripts/auto-instagram-publish.ts --dry-run
```

---

## 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `OAuthException: Invalid OAuth access token` | 토큰 만료 | refresh-instagram-token.ts 실행 |
| `Error: ig_user_id not configured` | secrets 미설정 | Step 6 재확인 |
| `Media upload failed` | 이미지 형식 불가 | JPEG, 4:5 비율 확인 |
| `Publishing limit reached` | 하루 25개 초과 | 발행 빈도 조정 |

---

> 참고: Meta Graph API 공식 문서 https://developers.facebook.com/docs/instagram-api
