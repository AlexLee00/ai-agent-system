# Darwin V2 — Skill 레지스트리 (Skill Registry)

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2 Jido Skills — AI-Researcher/AI Scientist-v2 패턴 기반.

---

## 등록된 스킬

| 스킬 | 모듈 | 역할 |
|------|------|------|
| `PaperSynthesis` | `Darwin.V2.Skill.PaperSynthesis` | 논문 핵심 기여 → 구조화 요약 |
| `Replication` | `Darwin.V2.Skill.Replication` | 논문 재현 검증 (실험 재실행) |
| `ResourceAnalyst` | `Darwin.V2.Skill.ResourceAnalyst` | AI-Researcher 패턴 — 수학↔코드 매핑 |
| `ExperimentDesign` | `Darwin.V2.Skill.ExperimentDesign` | 실험 설계 + 평가 지표 선정 |
| `VlmFeedback` | `Darwin.V2.Skill.VlmFeedback` | 결과물 시각 평가 (VLM) |
| `TreeSearch` | `Darwin.V2.Skill.TreeSearch` | AI Scientist-v2 진보적 트리 탐색 |

---

## 스킬 등록 방법

Commander에서 tools 리스트에 추가:

```elixir
use Jido.AI.Agent,
  name: "darwin_v2_commander",
  tools: [
    Darwin.V2.Skill.PaperSynthesis,
    Darwin.V2.Skill.ResourceAnalyst,
    Darwin.V2.Skill.TreeSearch,
    ...
  ]
```

---

## 신규 스킬 작성 규칙

```elixir
defmodule Darwin.V2.Skill.NewSkill do
  use Jido.Action,
    name: "darwin_v2_new_skill",
    schema: Zoi.object(%{
      input_field: [type: :string, required: true]
    })

  def run(params, _ctx) do
    # 구현
    {:ok, %{result: ...}}
  end
end
```
