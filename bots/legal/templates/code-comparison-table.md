# 코드 비교표 템플릿

> 사건번호: {{CASE_NUMBER}}
> 작성일: {{DATE}}
> 작성: 렌즈(Lens) 에이전트

---

## 1. 유사도 요약

| 분석 방법 | 유사도 |
|----------|--------|
| 라인 기반 | {{LINE_SIMILARITY}}% |
| 토큰 기반 | {{TOKEN_SIMILARITY}}% |
| 식별자 제거 토큰 | {{TOKEN_STRIPPED_SIMILARITY}}% |
| 구조 기반 | {{STRUCTURE_SIMILARITY}}% |
| **종합 유사도** | **{{COMPOSITE_SCORE}}%** |

**위험도 판정**: {{COPY_RISK}} (low/medium/high)

---

## 2. 파일별 유사도 상세

| 원고 파일 | 피고 파일 | 유사도 | 위험도 | 비고 |
|----------|----------|--------|--------|------|
{{#FILE_COMPARISONS}}
| `{{FILE_A}}` | `{{FILE_B}}` | {{SCORE}}% | {{RISK}} | {{NOTES}} |
{{/FILE_COMPARISONS}}

---

## 3. 기능 매핑 테이블

| # | 원고 기능 | 피고 기능 | 유사도 | 구현 비교 | 판정 |
|---|----------|----------|--------|----------|------|
{{#FUNCTION_MAPPINGS}}
| {{INDEX}} | {{PLAINTIFF_FEATURE}} | {{DEFENDANT_FEATURE}} | {{SIMILARITY}}% | {{IMPL_COMPARISON}} | {{VERDICT}} |
{{/FUNCTION_MAPPINGS}}

---

## 4. 주목할 유사 코드 (상위 5건)

{{#TOP_SIMILARITIES}}
### {{INDEX}}. {{FILE_PAIR}}

**원고 코드** (`{{FILE_A}}`, 라인 {{LINE_A}}):
```
{{CODE_A}}
```

**피고 코드** (`{{FILE_B}}`, 라인 {{LINE_B}}):
```
{{CODE_B}}
```

**유사도**: {{SIMILARITY}}% | **판정**: {{VERDICT}}

{{/TOP_SIMILARITIES}}

---

## 5. 복사 탐지 결과

### 5.1 변수명 변경 패턴
{{VARIABLE_RENAME_PATTERNS}}

### 5.2 코드 순서 변경 패턴
{{CODE_REORDER_PATTERNS}}

### 5.3 오픈소스/공통 패턴
{{OPENSOURCE_PATTERNS}}

---

## 6. 결론

{{LENS_CONCLUSION}}
