defmodule Jay.Core.LLM.Recommender do
  @moduledoc """
  팀별 LLM Recommender 공용 레이어 — 룰 기반 7차원 점수.

  사용법:
    use Jay.Core.LLM.Recommender, affinity_fn: &__MODULE__.agent_affinity/0

  또는 @agent_affinity 모듈 속성으로 직접 주입.
  """

  @model_order %{anthropic_haiku: 0, anthropic_sonnet: 1, anthropic_opus: 2}

  # ---- 공용 7차원 bias 함수 ----

  def length_bias(tokens, :anthropic_haiku),  do: (if tokens > 2000, do: -0.3, else: 0.1)
  def length_bias(tokens, :anthropic_sonnet), do: (if tokens > 5000, do: -0.2, else: 0.05)
  def length_bias(_tokens, :anthropic_opus),  do: 0.0
  def length_bias(_, _), do: 0.0

  def budget_bias(ratio, :anthropic_haiku),  do: ratio * 0.2
  def budget_bias(ratio, :anthropic_sonnet), do: (ratio - 0.3) * 0.15
  def budget_bias(ratio, :anthropic_opus),   do: (ratio - 0.6) * 0.1
  def budget_bias(_, _), do: 0.0

  def failure_bias(rate, _agent, model) when rate > 0.3 do
    case model do
      :anthropic_haiku  -> -0.4
      :anthropic_sonnet -> 0.2
      :anthropic_opus   -> 0.1
      _                 -> 0.0
    end
  end
  def failure_bias(_, _, _), do: 0.0

  def urgency_bias(:high, :anthropic_haiku),   do:  0.3
  def urgency_bias(:high, :anthropic_sonnet),  do: -0.1
  def urgency_bias(:high, :anthropic_opus),    do: -0.3
  def urgency_bias(:low, :anthropic_haiku),    do: -0.1
  def urgency_bias(:low, :anthropic_sonnet),   do:  0.1
  def urgency_bias(:low, :anthropic_opus),     do:  0.2
  def urgency_bias(_, _), do: 0.0

  def task_type_bias(:binary_classification, :anthropic_haiku),  do:  0.3
  def task_type_bias(:binary_classification, :anthropic_sonnet), do: -0.2
  def task_type_bias(:batch_filtering,       :anthropic_haiku),  do:  0.2
  def task_type_bias(:creative_generation,   :anthropic_sonnet), do:  0.2
  def task_type_bias(:creative_generation,   :anthropic_haiku),  do: -0.1
  def task_type_bias(:structured_reasoning,  :anthropic_sonnet), do:  0.1
  def task_type_bias(:code_generation,       :anthropic_sonnet), do:  0.2
  def task_type_bias(:code_generation,       :anthropic_opus),   do:  0.1
  def task_type_bias(_, _), do: 0.0

  def accuracy_bias(:critical, :anthropic_opus),   do:  0.5
  def accuracy_bias(:critical, :anthropic_sonnet), do:  0.2
  def accuracy_bias(:critical, :anthropic_haiku),  do: -0.3
  def accuracy_bias(:high, :anthropic_opus),       do:  0.2
  def accuracy_bias(:high, :anthropic_sonnet),     do:  0.1
  def accuracy_bias(_, _), do: 0.0

  @doc "점수 맵 → {primary, fallback_list} 결정"
  def scores_to_recommendation(scores) do
    sorted =
      scores
      |> Enum.sort_by(fn {model, score} ->
        {-score, Map.get(@model_order, model, 99)}
      end)

    case sorted do
      [] ->
        {:error, :no_candidates}

      [{primary, _} | rest] ->
        fallback = rest |> Enum.map(fn {m, _} -> m end)
        reason   = build_reason(sorted)
        {:ok, %{primary: primary, fallback: fallback, reason: reason}}
    end
  end

  defp build_reason(sorted) do
    sorted
    |> Enum.map(fn {m, s} -> "#{m}=#{Float.round(s, 2)}" end)
    |> Enum.join(", ")
  end

  defmacro __using__(opts) do
    affinity_fn = Keyword.get(opts, :affinity_fn)

    quote do
      require Logger

      @external_affinity_fn unquote(affinity_fn)

      @doc """
      에이전트 이름 + 컨텍스트 → 최적 모델 추천.
      반환: {:ok, %{primary: atom, fallback: [atom], reason: string}} | {:error, reason}
      """
      def recommend(agent_name, context \\ %{}) do
        affinity =
          if @external_affinity_fn do
            Map.get(@external_affinity_fn.(), to_string(agent_name), %{anthropic_haiku: 1.0})
          else
            Map.get(agent_affinity(), to_string(agent_name), %{anthropic_haiku: 1.0})
          end

        prompt_tokens = context[:prompt_tokens] || 500
        budget_ratio  = context[:budget_ratio]  || 1.0
        failure_rate  = context[:recent_failure_rate] || 0.0
        urgency       = context[:urgency]    || :medium
        task_type     = context[:task_type]  || :unknown
        accuracy      = context[:accuracy]   || :normal

        scores =
          affinity
          |> Enum.map(fn {model, base} ->
            score =
              base +
              Jay.Core.LLM.Recommender.length_bias(prompt_tokens, model) +
              Jay.Core.LLM.Recommender.budget_bias(budget_ratio, model) +
              Jay.Core.LLM.Recommender.failure_bias(failure_rate, agent_name, model) +
              Jay.Core.LLM.Recommender.urgency_bias(urgency, model) +
              Jay.Core.LLM.Recommender.task_type_bias(task_type, model) +
              Jay.Core.LLM.Recommender.accuracy_bias(accuracy, model)

            {model, score}
          end)

        Jay.Core.LLM.Recommender.scores_to_recommendation(scores)
      end
    end
  end
end
