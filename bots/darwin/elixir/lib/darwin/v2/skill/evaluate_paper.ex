defmodule Darwin.V2.Skill.EvaluatePaper do
  @moduledoc "논문 적합성 평가 스킬 — LLM 기반 10점 척도 + 구조화 출력."

  use Jido.Action,
    name: "darwin_evaluate_paper",
    description: "arXiv/HF 논문을 다윈팀 R&D 관점에서 10점 척도로 평가",
    schema: Zoi.object(%{
      title:    Zoi.string() |> Zoi.required(),
      abstract: Zoi.string() |> Zoi.required(),
      source:   Zoi.optional(Zoi.string()),
      tags:     Zoi.default(Zoi.list(Zoi.string()), [])
    })

  require Logger

  @impl Jido.Action
  def run(%{title: title, abstract: abstract} = params, _ctx) do
    source = params.source || "unknown"
    tags = params.tags || []

    prompt = """
    다음 논문을 다윈팀 R&D 에이전트 관점에서 평가하세요.

    제목: #{title}
    출처: #{source}
    태그: #{Enum.join(tags, ", ")}
    초록:
    #{abstract}

    평가 기준:
    1. 실제 구현 가능성 (theoretical vs. practical)
    2. 팀 제이 시스템과의 관련성 (AI 에이전트, LLM, 자동화)
    3. 성능/비용 개선 가능성
    4. 구현 복잡도 (낮을수록 좋음)
    5. 재현 가능성

    다음 JSON 형식으로 답하세요:
    {
      "score": 0~10,
      "implementable": true/false,
      "relevance": "high/medium/low",
      "summary_ko": "한국어 2줄 요약",
      "rationale": "평가 근거 2~3줄"
    }
    """

    case Darwin.V2.LLM.Selector.call_with_fallback(:evaluator, prompt, max_tokens: 400) do
      {:ok, %{response: text}} ->
        parse_evaluation(text, title)
      {:error, reason} ->
        Logger.warning("[darwin/evaluate_paper] LLM 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp parse_evaluation(text, title) do
    case Regex.run(~r/\{.*\}/s, text) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, data} ->
            {:ok, %{
              title: title,
              score: data["score"] || 0,
              implementable: data["implementable"] || false,
              relevance: data["relevance"] || "low",
              summary_ko: data["summary_ko"] || "",
              rationale: data["rationale"] || ""
            }}
          _ -> {:error, :parse_error}
        end
      _ -> {:error, :no_json}
    end
  end
end
