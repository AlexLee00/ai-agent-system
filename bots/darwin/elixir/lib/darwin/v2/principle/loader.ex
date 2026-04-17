defmodule Darwin.V2.Principle.Loader do
  @moduledoc """
  다윈 원칙 게이트 — 구현/적용 전 원칙 위반 여부 자기 비판.

  다윈 5대 원칙:
    P-D001: 표절 금지 — 논문 코드를 그대로 복사 금지 (변형/재구현 필요)
    P-D002: 검증 없이 main 적용 금지
    P-D003: 재현 불가 실험 결과 폐기
    P-D004: 비용 상한 준수 ($10/일)
    P-D005: 자율 레벨 L5 미달 시 마스터 승인 필요
  """

  require Logger

  @principles [
    %{id: "P-D001", desc: "표절 금지 — 원본 논문 코드 그대로 복사 금지"},
    %{id: "P-D002", desc: "검증 없이 main 브랜치 적용 금지"},
    %{id: "P-D003", desc: "재현 불가 실험 결과 폐기"},
    %{id: "P-D004", desc: "일일 LLM 비용 $10 초과 금지"},
    %{id: "P-D005", desc: "L5 미달 시 마스터 승인 요청"}
  ]

  @doc "구현 계획에 대한 원칙 자기 비판."
  @spec self_critique(map()) :: {:approved, []} | {:blocked, [map()]}
  def self_critique(plan) do
    if Application.get_env(:darwin, :principle_semantic_check, false) do
      llm_critique(plan)
    else
      rule_critique(plan)
    end
  end

  @doc "전체 원칙 목록 반환."
  @spec principles() :: [map()]
  def principles, do: @principles

  @doc "특정 도메인의 원칙 게이트 — self_critique/1 위임 래퍼."
  @spec check(atom(), map()) :: {:approved, []} | {:blocked, [map()]}
  def check(_domain, plan), do: self_critique(plan)

  # ---

  defp rule_critique(plan) do
    blocked =
      Enum.filter(@principles, fn p ->
        case p.id do
          "P-D002" -> plan[:skip_verification] == true
          "P-D004" ->
            case Darwin.V2.LLM.CostTracker.check_budget() do
              {:error, :budget_exceeded} -> true
              _ -> false
            end
          "P-D005" ->
            level = Darwin.V2.AutonomyLevel.level()
            level < 5 and plan[:auto_apply] == true
          _ -> false
        end
      end)

    if blocked == [] do
      {:approved, []}
    else
      Logger.warning("[darwin/principle] 원칙 위반: #{Enum.map(blocked, & &1.id) |> Enum.join(", ")}")
      {:blocked, blocked}
    end
  rescue
    _ -> {:approved, []}
  end

  defp llm_critique(plan) do
    principles_text =
      @principles
      |> Enum.map(&"#{&1.id}: #{&1.desc}")
      |> Enum.join("\n")

    prompt = """
    다음 다윈팀 원칙들을 검토하고, 아래 구현 계획이 위반하는 원칙이 있는지 판단하세요.
    위반 있으면 해당 원칙 ID를 쉼표로 나열, 없으면 "NONE"만 답하세요.

    원칙:
    #{principles_text}

    구현 계획:
    #{inspect(plan)}
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("principle.critique", prompt,
           max_tokens: 50,
           task_type: :structured_reasoning
         ) do
      {:ok, %{response: "NONE"}} ->
        {:approved, []}

      {:ok, %{response: text}} ->
        violated_ids = String.split(text, ~r/[,\s]+/, trim: true)
        violated = Enum.filter(@principles, &(&1.id in violated_ids))

        if violated == [] do
          {:approved, []}
        else
          {:blocked, violated}
        end

      _ ->
        {:approved, []}
    end
  rescue
    _ -> {:approved, []}
  end
end
