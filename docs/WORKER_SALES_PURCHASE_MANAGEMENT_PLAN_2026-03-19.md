# 워커 매출관리 내 매입관리 도입 설계안

작성일: 2026-03-19  
대상 시스템: `bots/worker/web/app/sales/page.js` 중심 워커 web 운영 화면  
관련 첨부 원천:
- [2025년 스터디카페 고정지출관리 월별.xlsx](/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내%20드라이브/002_본사업추진/300_커피랑_도서관/09_회계자료/2025%E1%84%82%E1%85%A7%E1%86%AB%20%E1%84%89%E1%85%B3%E1%84%90%E1%85%A5%E1%84%83%E1%85%B5%E1%84%8F%E1%85%A1%E1%84%91%E1%85%A6_%E1%84%80%E1%85%A9%E1%84%8C%E1%85%A5%E1%86%BC%E1%84%8C%E1%85%B5%E1%84%8E%E1%85%AE%E1%86%AF%E1%84%80%E1%85%AA%E1%86%AB%E1%84%85%E1%85%B5_%E1%84%8B%E1%85%AF%E1%86%AF%E1%84%87%E1%85%A7%E1%86%AF.xlsx)
- [2026년 스터디카페 고정지출관리 월별.xlsx](/Users/alexlee/Library/CloudStorage/GoogleDrive-***REMOVED***/내%20드라이브/002_본사업추진/300_커피랑_도%E1%84%89%E1%85%A5%E1%84%80%E1%85%AA%E1%86%AB/09_%E1%84%92%E1%85%AC%E1%84%80%E1%85%A8%E1%84%8C%E1%85%A1%E1%84%85%E1%85%AD/2026%E1%84%82%E1%85%A7%E1%86%AB%20%E1%84%89%E1%85%B3%E1%84%90%E1%85%A5%E1%84%83%E1%85%B5%E1%84%8F%E1%85%A1%E1%84%91%E1%85%A6_%E1%84%80%E1%85%A9%E1%84%8C%E1%85%A5%E1%86%BC%E1%84%8C%E1%85%B5%E1%84%8E%E1%85%AE%E1%86%AF%E1%84%80%E1%85%AA%E1%86%AB%E1%84%85%E1%85%B5_%E1%84%8B%E1%85%AF%E1%86%AF%E1%84%87%E1%85%A7%E1%86%AF.xlsx)

## 1. 결론

매출관리 안에 매입 자료 관리를 함께 넣는 방향은 맞다.  
다만 구현은 `매출` 화면을 그대로 확장하는 방식이 아니라, **동일 도메인 안에서 `매출 | 매입 | 손익` 탭형 구조로 분리**하는 것이 가장 자연스럽다.

코덱 추천 방향:
- 현재 `매출 관리` 페이지는 유지
- 내부 도구바/본문만 `매출 | 매입 | 손익` 탭 구조로 확장
- `PromptAdvisor`는 공용 유지
- 현재 선택된 탭 기준으로
  - 매출 등록
  - 매입 등록
  - 매입 현황 점검
  - 손익 요약
  요청을 처리

핵심 원칙:
- **원장(source of truth)은 매입내역 row 데이터**
- 월별 집계 시트는 참고/검증용
- 첨부 엑셀 파싱 결과는 프롬프트 본문이 아니라 **숨은 문맥과 결과 생성에만 반영**

## 2. 이유

### 2.1 첨부 엑셀 구조 확인 결과

두 엑셀 파일 모두 동일하게 아래 2개 시트를 가진다.

1. `2025년` 또는 `2026년`
- 월별 집계 시트
- 구조:
  - `구분`
  - `대분류`
  - `항목`
  - `1월 ~ 12월`
- 예:
  - `매출 / 서비스 / 스터디카페`
  - `지출 / 임대 및 관리 / 월세`
  - `지출 / 서비스 / 세무기장`

2. `매입내역`
- 거래 원장 시트
- 구조:
  - `거래일자`
  - `월추출`
  - `항목`
  - `품목`
  - `공급가액`
  - `수량`
  - `매입단가`
  - `비고`

즉 이 엑셀은 단순 파일 첨부가 아니라:
- 요약 집계
- 실제 개별 매입 원장
을 동시에 제공한다.

### 2.2 왜 탭형 구조가 맞는가

현재 매출관리의 목적은 다음 3가지를 한 화면에서 다루는 것이다.
- 거래 입력
- 현황 조회
- 요약/분석

여기에 매입을 넣으면 자연스럽게 도메인이 `재무`로 넓어진다.  
하지만 페이지를 새로 찢기보다 기존 매출관리 레이어를 재사용하는 것이 내부 MVP와 운영 안정성에 더 맞다.

탭형 구조의 장점:
- 비즈니스 목표
  - 매출과 매입을 같은 경영 뷰에서 빠르게 오갈 수 있다.
- 서비스 기획 구조
  - 입력형 기능과 조회형 기능을 유지한 채 도메인만 확장할 수 있다.
- 개발 실현 가능성
  - 현재 `sales/page.js`, `PromptAdvisor`, `PendingReviewSection`, `DataTable`를 그대로 재사용 가능하다.
- 데이터 구조 및 확장성
  - `sales`와 `expenses`를 병렬 테이블로 두고, `손익`은 조인/집계 뷰로 만들 수 있다.
- 운영 안정성
  - 기존 매출 플로우를 깨지 않고 새 도메인을 추가할 수 있다.
- SaaS 확장 가능성
  - 추후 고객사별로 `매출/매입/정산/원가관리`까지 확장하기 쉽다.

## 3. 구현/설계 포인트

### 3.1 지금 당장 필요한 구조

#### 화면 구조

기존 [sales/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/sales/page.js) 안에서 아래 구조로 확장한다.

- Hero
  - `누적 매출`
  - `누적 매입`
  - `이번 달 손익`
- PromptAdvisor
  - 현재 탭 기준 placeholder / suggestion 분기
- 운영 카드 헤더
  - `매출 | 매입 | 손익`
  - 우측 `+ 수동 등록`
- 본문
  - `매출` 탭: 기존 리스트/차트 유지
  - `매입` 탭: 매입 요약 + 리스트
  - `손익` 탭: 월별 매출/매입/순이익 비교

#### 탭별 UX 제안

`매출`
- 현재 구조 유지
- 목록 / 차트 전환 유지

`매입`
- 요약 카드
  - `이번 달 매입`
  - `고정지출`
  - `변동매입`
- 리스트
  - 날짜
  - 항목
  - 품목
  - 공급가액
  - 수량
  - 단가
  - 비고
- `+ 수동 등록`
- 첨부 엑셀 업로드

`손익`
- 요약 카드
  - `이번 달 매출`
  - `이번 달 매입`
  - `이번 달 손익`
- 월별 비교 차트
- 카테고리별 비용 분포

### 3.2 DB 스키마 초안

기존 [worker.sales](/Users/alexlee/projects/ai-agent-system/bots/worker/migrations/002-phase2-tables.sql)와 같은 계열로 신규 테이블을 추가한다.

```sql
CREATE TABLE IF NOT EXISTS worker.expenses (
    id              SERIAL PRIMARY KEY,
    company_id      TEXT NOT NULL REFERENCES worker.companies(id),
    date            DATE NOT NULL DEFAULT CURRENT_DATE,
    category        TEXT,
    item_name       TEXT,
    amount          INTEGER NOT NULL,
    quantity        NUMERIC(12,2),
    unit_price      NUMERIC(12,2),
    note            TEXT,
    expense_type    TEXT DEFAULT 'variable',
    source_type     TEXT DEFAULT 'manual',
    source_file_id  INTEGER REFERENCES worker.documents(id),
    source_row_key  TEXT,
    registered_by   INTEGER REFERENCES worker.users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_worker_expenses_company
ON worker.expenses(company_id, date)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_worker_expenses_source_row
ON worker.expenses(company_id, source_file_id, source_row_key)
WHERE deleted_at IS NULL AND source_file_id IS NOT NULL AND source_row_key IS NOT NULL;
```

#### 필드 설계 이유

- `category`
  - 엑셀의 `항목`
  - 예: `월세`, `세금`, `알바`, `키오스크`, `기타`
- `item_name`
  - 엑셀의 `품목`
- `amount`
  - 공급가액
- `quantity`, `unit_price`
  - 원본 원장 보존
- `expense_type`
  - `fixed` / `variable`
  - 월별 집계 또는 규칙 기반 분류 가능
- `source_type`
  - `manual`
  - `excel_import`
  - `ai_proposal`
  - 추후 `card_statement`, `tax_invoice`
- `source_file_id`, `source_row_key`
  - 업로드 원본과 행 단위 추적용
  - 중복 import 방지용

### 3.3 API 초안

매출 API와 같은 패턴으로 병렬 확장한다.

#### 목록/등록/수정/삭제
- `GET /api/expenses`
- `GET /api/expenses/summary`
- `POST /api/expenses`
- `PUT /api/expenses/:id`
- `DELETE /api/expenses/:id`

#### 제안형 입력
- `POST /api/expenses/proposals`
- `POST /api/expenses/proposals/:feedback_session_id/confirm`
- `POST /api/expenses/proposals/:feedback_session_id/reject`

#### 엑셀 import
- `POST /api/expenses/import/excel`

반환 요약 초안:
```json
{
  "today": { "total": 0, "count": 0 },
  "lifetime": { "total": 0, "count": 0 },
  "currentMonth": { "total": 0, "count": 0 },
  "monthly": [],
  "daily30": [],
  "byCategory": []
}
```

### 3.4 PromptAdvisor 적용 방식

공용 [PromptAdvisor.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/PromptAdvisor.js)를 그대로 쓴다.

탭별 예시:

`매출`
- `오늘 상품판매 5만원 매출 등록해줘`
- `어제 서비스 매출 12만원 등록해줘`

`매입`
- `1월 27일 가습기 94,000원 매입 등록해줘`
- `오늘 세무기장 88,000원 지출 등록해줘`
- `이번 주 고정지출 누락 점검해줘`

`손익`
- `이번 달 손익 요약해줘`
- `월세와 관리비 포함한 고정지출 현황 보여줘`

중요:
- 첨부파일 파싱 결과를 프롬프트 입력창에 직접 넣지 않는다.
- 이미 정리된 워커 web 불변식대로:
  - 사용자 입력은 입력창
  - 첨부파일 파싱 내용은 숨은 문맥
  - 결과 생성 시에만 합성

### 3.5 엑셀 파서 설계

#### 우선 반영 대상
- `매입내역` 시트

#### 참고/검증용
- `2025년`, `2026년` 월별 집계 시트

#### 이유

`매입내역` 시트는 transaction row이므로 source of truth로 적합하다.  
반면 연간 월별 시트는 summary 성격이 강해서, 실제 원장과 어긋날 때 어느 쪽을 믿을지 애매해진다.

#### 파싱 규칙 초안

입력 컬럼:
- `거래일자`
- `월추출`
- `항목`
- `품목`
- `공급가액`
- `수량`
- `매입단가`
- `비고`

정규화 출력:
- `date`
- `category`
- `item_name`
- `amount`
- `quantity`
- `unit_price`
- `note`
- `source_row_key`

#### Excel 날짜 처리

엑셀 `거래일자` 값은 serial number로 들어와 있다.
- 예: `46024`

따라서 parser에서:
- Excel serial → ISO date
변환이 필요하다.

#### 카테고리 정규화 초안

원본 예:
- `알바`
- `세금`
- `기타`
- `프린터 렌탈`
- `키오스크`
- `커피가루`

정규화 방향:
- 1차 MVP에서는 **원문 유지**
- 나중에만 mapping layer 추가

이유:
- 너무 이른 시점에 카테고리 canonicalization을 강제하면 오히려 실무 입력과 어긋날 수 있다.

### 3.6 손익 계산 규칙

`손익` 탭은 별도 원장 테이블 없이 집계로 계산한다.

월별 손익:
```text
손익 = 월별 매출 합계 - 월별 매입 합계
```

고정/변동 분리:
- `expense_type='fixed'`
- `expense_type='variable'`

고정비 판정 1차:
- 업로드 엑셀의 연간 월별 시트 기준 참고
- 또는 카테고리 rule
  - `월세`, `관리비`, `세무기장`, `인터넷/전화`, `렌탈` → `fixed`
- 나머지 → `variable`

## 4. 리스크 또는 TODO

### 4.1 리스크

#### 리스크 1. 월별 집계 시트를 source로 삼으면 정합성 충돌

월별 집계 시트는 사람이 관리한 summary라서,
- 원장보다 앞서 수정될 수도 있고
- 누락을 숨길 수도 있다.

따라서 source of truth는 반드시 `매입내역` row로 둬야 한다.

#### 리스크 2. 중복 업로드

같은 엑셀 파일을 여러 번 올릴 가능성이 높다.

필수 대응:
- `source_file_id`
- `source_row_key`
로 중복 방지

#### 리스크 3. Excel 날짜 serial 변환 오류

엑셀 serial date 처리에서 하루 오차가 나면,
- 월별 합계
- 손익 비교
- 회계 검증
모두 깨진다.

따라서 parser test가 필요하다.

#### 리스크 4. 고정비/변동비 판정 과도한 자동화

초기에는 자동 분류보다
- 원문 보존
- 최소 rule
가 더 안전하다.

### 4.2 TODO

1. `worker.expenses` 마이그레이션 추가
2. `expenses` API 추가
3. `sales/page.js`를 `매출 | 매입 | 손익` 탭 구조로 확장
4. `매입내역` 엑셀 parser 추가
5. `PromptAdvisor`의 매입 제안 흐름 추가
6. 손익 집계 카드 추가
7. 월별 집계 시트와 원장 시트의 검증 로직 추가

## 5. 다음 단계

가장 자연스러운 다음 단계는 아래 순서다.

1. **DB 스키마 먼저 구현**
- `worker.expenses` 마이그레이션

2. **API 레이어 구현**
- `GET/POST/PUT/DELETE /api/expenses`
- `GET /api/expenses/summary`

3. **화면 탭 구조 구현**
- `매출 | 매입 | 손익`

4. **엑셀 import parser 구현**
- `매입내역` 시트 기준

5. **손익 요약 연결**
- 월별 매출/매입/순이익 카드 및 차트

코덱 추천 1순위는  
**지금 바로 `worker.expenses` 마이그레이션과 `expenses` API부터 구현하는 것**이다.

이유:
- 화면은 기존 구조를 재사용할 수 있지만,
- 원장 테이블이 먼저 안정적으로 있어야
  - 수동 등록
  - 엑셀 import
  - PromptAdvisor 제안
  - 손익 집계
가 같은 기준으로 연결된다.
