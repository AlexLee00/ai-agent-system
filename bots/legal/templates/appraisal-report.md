# 감 정 서

> **주의**: 이 파일은 템플릿입니다. 실제 감정서는 저스틴팀이 자동 생성하며, 마스터(감정인)가 최종 검토 후 서명하여 법원에 제출합니다.

---

**사 건**: {{CASE_NUMBER}} {{CASE_TYPE_LABEL}}
**법 원**: {{COURT}}
**원 고**: {{PLAINTIFF}}
**피 고**: {{DEFENDANT}}
**감 정 인**: {{APPRAISER_NAME}}
**감정일**: {{APPRAISAL_DATE}}

---

## 1. 감정 개요

### 1.1 감정 목적

본 감정은 {{COURT}}의 감정 촉탁에 따라, {{CASE_NUMBER}} {{CASE_TYPE_LABEL}} 사건에서 법원이 제시한 감정사항에 대하여 전문가적 판단을 제공함을 목적으로 합니다.

### 1.2 감정사항

{{#APPRAISAL_ITEMS}}
{{INDEX}}. {{ITEM}}
{{/APPRAISAL_ITEMS}}

### 1.3 감정 기간

감정 착수일: {{START_DATE}}
감정서 제출일: {{SUBMIT_DATE}}

---

## 2. 사건 및 감정소요 분석

### 2.1 사건 경위

{{CASE_BACKGROUND}}

### 2.2 주요 쟁점

{{KEY_ISSUES}}

### 2.3 감정 착수 결정 사항

{{INCEPTION_DECISIONS}}

---

## 3. 분석 방법론

### 3.1 사용 도구 및 기술

| 분류 | 도구/방법 | 목적 |
|------|----------|------|
| 코드 비교 | 문자열/토큰/구조 유사도 분석 | 코드 유사도 측정 |
| 기능 분석 | 기능 매핑 테이블 작성 | 기능별 대응 관계 파악 |
| 구조 분석 | AST 파싱, 모듈 의존성 분석 | 소프트웨어 구조 파악 |
| 판례 분석 | 국내외 유사 판례 검색 | 법적 근거 확보 |

### 3.2 분석 기준

{{ANALYSIS_CRITERIA}}

---

## 4. 분석 결과

### 4.1 소스코드 유사도 분석

{{#SIMILARITY_ANALYSIS}}
**종합 유사도**: {{COMPOSITE_SCORE}}%
- 라인 기반 유사도: {{LINE_SIMILARITY}}%
- 토큰 기반 유사도: {{TOKEN_SIMILARITY}}%
- 구조 기반 유사도: {{STRUCTURE_SIMILARITY}}%

**위험도 판정**: {{COPY_RISK}}
{{/SIMILARITY_ANALYSIS}}

### 4.2 기능 매핑 분석

{{FUNCTION_MAPPING_TABLE}}

### 4.3 원고 소프트웨어 분석

{{PLAINTIFF_ANALYSIS}}

### 4.4 피고 소프트웨어 분석

{{DEFENDANT_ANALYSIS}}

### 4.5 양측 비교 분석

{{COMPARISON_ANALYSIS}}

---

## 5. 판례 참조

### 5.1 국내 판례

{{DOMESTIC_PRECEDENTS}}

### 5.2 해외 판례

{{FOREIGN_PRECEDENTS}}

---

{{#INSPECTION_RESULTS}}
## 6. 현장실사 결과

### 6.1 실사 개요

실사 일시: {{INSPECTION_DATE}}
실사 장소: {{INSPECTION_LOCATION}}

### 6.2 SW 기능 분류 및 가동 판정

| 대분류 | 중분류 | 소분류 | 판정 | 비고 |
|--------|--------|--------|------|------|
{{INSPECTION_TABLE}}

### 6.3 가동률 요약

- 가동: {{OPERATIONAL_COUNT}}개 ({{OPERATIONAL_PERCENT}}%)
- 부분가동: {{PARTIAL_COUNT}}개 ({{PARTIAL_PERCENT}}%)
- 불가동: {{INOPERATIVE_COUNT}}개 ({{INOPERATIVE_PERCENT}}%)

{{/INSPECTION_RESULTS}}

---

## {{SECTION_CONCLUSION_NUMBER}}. 감정 의견

### {{SECTION_CONCLUSION_NUMBER}}.1 결론

{{CONCLUSION}}

### {{SECTION_CONCLUSION_NUMBER}}.2 근거

{{CONCLUSION_BASIS}}

---

## 첨부 자료

{{#ATTACHMENTS}}
- {{ATTACHMENT_NAME}}
{{/ATTACHMENTS}}

---

> 위와 같이 감정합니다.
>
> {{APPRAISAL_DATE}}
>
> 감정인: {{APPRAISER_NAME}} (서명/인)

---

*[이 감정서는 저스틴팀이 작성한 초안입니다. 마스터(감정인)의 검토 및 수정이 필요합니다.]*
