defmodule Luna.V2.LLM.Recommender do
  @moduledoc """
  루나 V2 LLM 모델 추천 — 룰 기반 7차원 점수 계산 (투자 에이전트 특화).

  입력: agent_name + context map
    :prompt_tokens        — 프롬프트 토큰 수 추정 (integer)
    :budget_ratio         — 남은 예산 비율 0.0~1.0 (float, 1.0=여유)
    :recent_failure_rate  — 최근 24h 실패율 0.0~1.0 (float)
    :urgency              — :high | :medium | :low (atom)
    :task_type            — :trade_evaluation | :query_decomposition | :rationale_generation |
                            :binary_classification | :structured_reasoning |
                            :keyword_extraction | :unknown
    :accuracy             — :critical | :high | :normal (atom, 기본 :normal)

  출력: {:ok, %{primary: atom, fallback: [atom], reason: string, scores: [...]}}

  7차원: base_affinity + length_bias + budget_bias + failure_bias + urgency_bias
         + task_type_bias + accuracy_bias

  재귀 방지: LLM 호출 없음 (순수 룰).
  """

  @agent_affinity %{
    "luna.commander"             => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6, anthropic_opus: 0.3},
    "luna.decision_rationale"    => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "luna.rag.query_planner"     => %{anthropic_haiku: 1.0},
    "luna.rag.multi_source"      => %{anthropic_haiku: 1.0},
    "luna.rag.quality_evaluator" => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.rag.response_synth"    => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
    "luna.self_rewarding_judge"  => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.reflexion"             => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
    "luna.espl"                  => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "luna.principle.critique"    => %{anthropic_opus: 1.0, anthropic_sonnet: 0.8},
    "luna.mapek.analyzer"        => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
    "luna.strategy.validator"    => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    # 레거시 호환
    "luna.rag_query_planner"     => %{anthropic_haiku: 1.0},
  }

  @model_order %{anthropic_haiku: 0, anthropic_sonnet: 1, anthropic_opus: 2}

  @doc "에이전트 이름 + 컨텍스트 → 최적 모델 추천."
  def recommend(agent_name, context \\ %{}) do
    affinity = Map.get(@agent_affinity, to_string(agent_name), %{anthropic_haiku: 1.0})

    scores =
      affinity
      |> Enum.map(fn {model, base} ->
        total =
          base +
            length_bias(context[:prompt_tokens] || 500, model) +
            budget_bias(context[:budget_ratio] || 1.0, model) +
            failure_bias(context[:recent_failure_rate] || 0.0, model) +
            urgency_bias(context[:urgency] || :medium, model) +
            task_type_bias(context[:task_type] || :unknown, model) +
            accuracy_bias(context[:accuracy] || :normal, model)

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

  # 룰 1: 프롬프트 길이
  defp length_bias(tokens, model) do
    cond do
      tokens >= 8_000 -> boost_long(model)
      tokens < 500    -> penalty_overkill(model)
      true            -> 0.0
    end
  end

  defp boost_long(:anthropic_sonnet), do: 0.2
  defp boost_long(:anthropic_opus),   do: 0.3
  defp boost_long(_),                 do: 0.0

  defp penalty_overkill(:anthropic_sonnet), do: -0.3
  defp penalty_overkill(:anthropic_opus),   do: -0.5
  defp penalty_overkill(_),                 do: 0.0

  # 룰 2: 예산
  defp budget_bias(ratio, model) do
    cond do
      ratio < 0.10 -> force_cheapest(model)
      ratio < 0.30 -> downgrade(model)
      true         -> 0.0
    end
  end

  defp force_cheapest(:anthropic_haiku),  do: 0.5
  defp force_cheapest(:anthropic_sonnet), do: -1.0
  defp force_cheapest(:anthropic_opus),   do: -2.0

  defp downgrade(:anthropic_haiku),  do: 0.3
  defp downgrade(:anthropic_sonnet), do: -0.2
  defp downgrade(:anthropic_opus),   do: -0.5

  # 룰 3: 실패율
  defp failure_bias(rate, _model) do
    cond do
      rate > 0.30 -> -0.8
      rate > 0.20 -> -0.4
      rate > 0.10 -> -0.1
      true        -> 0.0
    end
  end

  # 룰 4: 긴급도
  defp urgency_bias(:high, :anthropic_haiku),  do: 0.3
  defp urgency_bias(:high, :anthropic_sonnet), do: -0.2
  defp urgency_bias(:high, :anthropic_opus),   do: -0.5
  defp urgency_bias(:low, :anthropic_opus),    do: 0.2
  defp urgency_bias(:low, :anthropic_sonnet),  do: 0.1
  defp urgency_bias(_, _),                     do: 0.0

  # 룰 5: 작업 유형 (투자 특화)
  defp task_type_bias(:trade_evaluation, model) do
    case model do
      :anthropic_haiku  -> 0.3
      :anthropic_sonnet -> 0.1
      :anthropic_opus   -> -0.1
    end
  end

  defp task_type_bias(:query_decomposition, model) do
    case model do
      :anthropic_haiku  -> 0.4
      :anthropic_sonnet -> -0.2
      :anthropic_opus   -> -0.5
    end
  end

  defp task_type_bias(:rationale_generation, model) do
    case model do
      :anthropic_sonnet -> 0.3
      :anthropic_haiku  -> 0.0
      :anthropic_opus   -> 0.1
    end
  end

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
      :anthropic_opus   -> 0.2
      :anthropic_haiku  -> 0.0
    end
  end

  defp task_type_bias(:keyword_extraction, model) do
    case model do
      :anthropic_haiku  -> 0.3
      :anthropic_sonnet -> -0.1
      :anthropic_opus   -> -0.3
    end
  end

  defp task_type_bias(_, _), do: 0.0

  # 룰 6: 정확도 요구 수준
  defp accuracy_bias(:critical, model) do
    case model do
      :anthropic_opus   -> 0.5
      :anthropic_sonnet -> 0.2
      :anthropic_haiku  -> -0.3
    end
  end

  defp accuracy_bias(:high, model) do
    case model do
      :anthropic_sonnet -> 0.3
      :anthropic_opus   -> 0.1
      :anthropic_haiku  -> -0.1
    end
  end

  defp accuracy_bias(:normal, _model), do: 0.0
  defp accuracy_bias(_, _model),       do: 0.0

  # -------------------------------------------------------------------
  # 이유 생성
  # -------------------------------------------------------------------

  defp compose_reason(ctx) do
    reasons = []
    reasons = if is_number(ctx[:budget_ratio]) and ctx[:budget_ratio] < 0.30, do: reasons ++ ["예산 부족"], else: reasons
    reasons = if ctx[:urgency] == :high, do: reasons ++ ["긴급"], else: reasons
    reasons = if is_number(ctx[:recent_failure_rate]) and ctx[:recent_failure_rate] > 0.15, do: reasons ++ ["실패율 높음"], else: reasons
    reasons = if is_integer(ctx[:prompt_tokens]) and ctx[:prompt_tokens] > 8_000, do: reasons ++ ["긴 컨텍스트"], else: reasons
    reasons = if ctx[:accuracy] in [:critical, :high], do: reasons ++ ["정확도 #{ctx[:accuracy]}"], else: reasons

    reasons =
      case ctx[:task_type] do
        :trade_evaluation    -> reasons ++ ["거래 평가"]
        :query_decomposition -> reasons ++ ["쿼리 분해"]
        :rationale_generation -> reasons ++ ["근거 생성"]
        _                    -> reasons
      end

    if reasons == [], do: "정책 권장", else: Enum.join(reasons, " / ")
  end
end
