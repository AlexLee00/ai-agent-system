defmodule Darwin.V2.Skill.PlanImplementation do
  @moduledoc "구현 계획 수립 스킬 — 논문 기반 에디슨 실행 계획 생성."

  use Jido.Action,
    name: "darwin_plan_implementation",
    description: "고적합 논문 기반 구현 계획 수립 (에디슨 실행 지시 포함)",
    schema: Zoi.object(%{
      title:      Zoi.string() |> Zoi.required(),
      score:      Zoi.float() |> Zoi.required(),
      summary_ko: Zoi.optional(Zoi.string()),
      rationale:  Zoi.optional(Zoi.string())
    })

  require Logger

  @impl Jido.Action
  def run(%{title: title, score: score} = params, _ctx) do
    level = Darwin.V2.AutonomyLevel.level()
    summary = params.summary_ko || ""
    rationale = params.rationale || ""

    prompt = """
    다음 논문의 핵심 아이디어를 팀 제이 시스템에 구현하기 위한 상세 계획을 수립하세요.

    논문: #{title}
    적합도: #{score}/10
    요약: #{summary}
    평가 근거: #{rationale}
    현재 자율 레벨: L#{level}

    계획에 포함할 내용:
    1. 구현 목표 (1줄)
    2. 구현 위치 (파일 경로)
    3. 핵심 변경 사항 (3~5개 bullet)
    4. 예상 효과
    5. 검증 방법
    6. 리스크 및 완화책

    JSON 형식:
    {
      "goal": "...",
      "target_path": "...",
      "changes": ["...", "..."],
      "expected_effect": "...",
      "verification": "...",
      "risk": "...",
      "autonomy_gate": "L#{level} 자동 실행" or "마스터 승인 필요"
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(:planner, prompt, max_tokens: 600) do
      {:ok, %{response: text}} ->
        parse_plan(text, title, level)
      {:error, reason} ->
        Logger.warning("[darwin/plan_impl] LLM 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp parse_plan(text, title, level) do
    case Regex.run(~r/\{.*\}/s, text) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, data} ->
            {:ok, Map.merge(data, %{"title" => title, "autonomy_level" => level})}
          _ -> {:error, :parse_error}
        end
      _ -> {:error, :no_json}
    end
  end
end
