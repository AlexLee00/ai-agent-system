---
name: luna-shadow-auto-promote
description: Evaluate whether Luna shadow decisions are eligible for master promotion review without performing cutover.
triggers:
  - shadow promotion
  - luna promotion readiness
  - master review candidate
---

# Shadow Auto Promote

- Owner: luna
- Category: orchestration
- Contract: Evaluate whether shadow decisions are eligible for promotion.
- Safety: recommendation only; promotion requires explicit cutover approval.
