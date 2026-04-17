defmodule Sigma.V2.LLM.Recommender do
  @moduledoc """
  LLM 모델 추천 메타 에이전트 — 룰 기반 6차원 점수 계산으로 동적 모델 추천.

  입력: agent_name + context map
    :prompt_tokens        — 프롬프트 토큰 수 추정 (integer)
    :budget_ratio         — 남은 예산 비율 0.0~1.0 (float, 1.0=여유)
    :recent_failure_rate  — 최근 24h 실패율 0.0~1.0 (float)
    :urgency              — :high | :medium | :low (atom)
    :task_type            — :binary_classification | :structured_reasoning |
                            :creative_generation | :batch_filtering | :unknown

  출력: {:ok, %{primary: atom, fallback: [atom], reason: string, scores: [...]}}

  재귀 방지: Recommender 자체는 LLM 호출 없음 (순수 룰).
  참조: docs/codex/CODEX_SIGMA_PHASE2_LLM_AUTONOMOUS.md
  """

  # 실제 LLM 호출하는 에이전트의 모델 기본 적합도 (base score)
  @agent_affinity %{
    "reflexion"              => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6, anthropic_opus: 0.3},
    "espl.crossover"         => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "espl.mutation"          => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "self_rag.retrieve_gate" => %{anthropic_haiku: 1.0},
    "self_rag.relevance"     => %{anthropic_haiku: 1.0},
    "principle.critique"     => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.7}
  }

  # 동점 시 가벼운 모델 우선 (비용 효율)
  @model_order %{anthropic_haiku: 0, anthropic_sonnet: 1, anthropic_opus: 2}

  @doc """
  에이전트 이름 + 컨텍스트 → 최적 모델 추천.
  """
  def recommend(agent_name, context \\ %{}) do
    affinity = Map.get(@agent_affinity, to_string(agent_name), %{anthropic_haiku: 1.0})

    scores =
      affinity
      |> Enum.map(fn {model, base} ->
        total =
          base +
          length_bias(context[:prompt_tokens] || 500, model) +
          budget_bias(context[:budget_ratio] || 1.0, model) +
          failure_bias(context[:recent_failure_rate] || 0.0, agent_name, model) +
          urgency_bias(context[:urgency] || :medium, model) +
          task_type_bias(context[:task_type] || :unknown, model)
        {model, Float.round(total, 3)}
      end)
      |> Enum.sort_by(fn {m, s} -> {-s, Map.get(@model_order, m, 99)} end)

    reason = compose_reason(context)

    case scores do
      [] ->
        {:error, :no_candidate}

      [{primary, _}] ->
        {:ok, %{primary: primary, fallback: [], reason: reason, scores: scores}}

      [{primary, _} | rest] ->
        fallback = rest |> Enum.reject(fn {_, s} -> s <= 0.0 end) |> Enum.map(&elem(&1, 0))
        {:ok, %{primary: primary, fallback: fallback, reason: reason, scores: scores}}
    end
  end

  # -------------------------------------------------------------------
  # 룰 1: 프롬프트 길이 가중치
  # -------------------------------------------------------------------

  defp length_bias(tokens, model) do
    cond do
      tokens >= 8_000 -> boost_if_long_context(model)
      tokens >= 2_000 -> 0.0
      tokens >= 500   -> 0.0
      true            -> penalty_if_overkill(model)
    end
  end

  defp boost_if_long_context(:anthropic_sonnet), do: 0.2
  defp boost_if_long_context(:anthropic_opus),   do: 0.3
  defp boost_if_long_context(_),                 do: 0.0

  defp penalty_if_overkill(:anthropic_sonnet), do: -0.3
  defp penalty_if_overkill(:anthropic_opus),   do: -0.5
  defp penalty_if_overkill(_),                 do: 0.0

  # -------------------------------------------------------------------
  # 룰 2: 예산 잔여량 기반 다운그레이드
  # -------------------------------------------------------------------

  defp budget_bias(budget_ratio, model) do
    cond do
      budget_ratio < 0.10 -> force_cheapest(model)
      budget_ratio < 0.30 -> downgrade_one_tier(model)
      true                -> 0.0
    end
  end

  defp force_cheapest(:anthropic_haiku),  do: 0.5
  defp force_cheapest(:anthropic_sonnet), do: -1.0
  defp force_cheapest(:anthropic_opus),   do: -2.0

  defp downgrade_one_tier(:anthropic_haiku),  do: 0.3
  defp downgrade_one_tier(:anthropic_sonnet), do: -0.2
  defp downgrade_one_tier(:anthropic_opus),   do: -0.5

  # -------------------------------------------------------------------
  # 룰 3: 최근 실패율 기반 조정
  # -------------------------------------------------------------------

  defp failure_bias(failure_rate, _agent, _model) do
    cond do
      failure_rate > 0.30 -> -0.8
      failure_rate > 0.20 -> -0.4
      failure_rate > 0.10 -> -0.1
      true                -> 0.0
    end
  end

  # -------------------------------------------------------------------
  # 룰 4: 긴급도
  # -------------------------------------------------------------------

  defp urgency_bias(:high, model) do
    case model do
      :anthropic_haiku  -> 0.3
      :anthropic_sonnet -> -0.2
      :anthropic_opus   -> -0.5
    end
  end

  defp urgency_bias(:low, model) do
    case model do
      :anthropic_opus   -> 0.2
      :anthropic_sonnet -> 0.1
      :anthropic_haiku  -> 0.0
    end
  end

  defp urgency_bias(:medium, _model), do: 0.0
  defp urgency_bias(_, _model),       do: 0.0

  # -------------------------------------------------------------------
  # 룰 5: 작업 유형
  # -------------------------------------------------------------------

  defp task_type_bias(:binary_classification, model) do
    case model do
      :anthropic_haiku  -> 0.4
      :anthropic_sonnet -> -0.2
      :anthropic_opus   -> -0.6
    end
  end

  defp task_type_bias(:structured_reasoning, model) do
    case model do
      :anthropic_sonnet -> 0.3
      :anthropic_haiku  -> 0.0
      :anthropic_opus   -> 0.2
    end
  end

  defp task_type_bias(:creative_generation, model) do
    case model do
      :anthropic_sonnet -> 0.4
      :anthropic_opus   -> 0.3
      :anthropic_haiku  -> -0.2
    end
  end

  defp task_type_bias(:batch_filtering, model) do
    case model do
      :anthropic_haiku  -> 0.5
      :anthropic_sonnet -> -0.3
      :anthropic_opus   -> -0.7
    end
  end

  defp task_type_bias(_, _), do: 0.0

  # -------------------------------------------------------------------
  # 이유 생성
  # -------------------------------------------------------------------

  defp compose_reason(ctx) do
    budget_ratio  = ctx[:budget_ratio]
    urgency       = ctx[:urgency]
    failure_rate  = ctx[:recent_failure_rate]
    prompt_tokens = ctx[:prompt_tokens]

    reasons = []
    reasons = if is_number(budget_ratio) and budget_ratio < 0.30, do: reasons ++ ["예산 부족"], else: reasons
    reasons = if urgency == :high, do: reasons ++ ["긴급"], else: reasons
    reasons = if is_number(failure_rate) and failure_rate > 0.15, do: reasons ++ ["실패율 높음"], else: reasons
    reasons = if is_integer(prompt_tokens) and prompt_tokens > 8_000, do: reasons ++ ["긴 컨텍스트"], else: reasons

    if reasons == [], do: "정책 권장", else: Enum.join(reasons, " / ")
  end
end
