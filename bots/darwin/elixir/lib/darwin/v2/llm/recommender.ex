defmodule Darwin.V2.LLM.Recommender do
  @moduledoc """
  다윈 V2 LLM 모델 추천 — 룰 기반 7차원 점수 계산 (연구 에이전트 특화).

  입력: agent_name + context map
    :prompt_tokens        — 프롬프트 토큰 수 추정 (integer)
    :budget_ratio         — 남은 예산 비율 0.0~1.0 (float, 1.0=여유)
    :recent_failure_rate  — 최근 24h 실패율 0.0~1.0 (float)
    :urgency              — :high | :medium | :low (atom)
    :task_type            — :paper_analysis | :code_generation | :keyword_extraction |
                            :evaluation_scoring | :binary_classification |
                            :structured_reasoning | :creative_generation |
                            :batch_filtering | :unknown
    :accuracy             — :critical | :high | :normal (atom, 기본 :normal)

  출력: {:ok, %{primary: atom, fallback: [atom], reason: string, scores: [...]}}

  7차원: base_affinity + length_bias + budget_bias + failure_bias + urgency_bias
         + task_type_bias (research_affinity 포함) + accuracy_bias

  재귀 방지: LLM 호출 없음 (순수 룰).
  """

  # 연구 에이전트별 모델 기본 적합도 (base score)
  # darwin.* 키: V2 네임스페이스 / 단축 키: 구버전 호환
  @agent_affinity %{
    # V2 네임스페이스
    "darwin.scanner"   => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.5},
    "darwin.evaluator" => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5, anthropic_opus: 0.3},
    "darwin.planner"   => %{anthropic_sonnet: 1.0, anthropic_opus: 0.6, anthropic_haiku: 0.3},
    "darwin.edison"    => %{anthropic_sonnet: 1.0, anthropic_opus: 0.5, anthropic_haiku: 0.3},
    "darwin.verifier"  => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6, anthropic_opus: 0.3},
    "darwin.commander" => %{anthropic_opus: 1.0, anthropic_sonnet: 0.7},
    "darwin.reflexion" => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5, anthropic_opus: 0.3},
    "darwin.espl"      => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.6},
    "darwin.self_rag"  => %{anthropic_haiku: 1.0},
    # 구버전 호환 키
    "evaluator"          => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.7, anthropic_opus: 0.2},
    "planner"            => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5, anthropic_opus: 0.3},
    "implementor"        => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.4, anthropic_opus: 0.4},
    "verifier"           => %{anthropic_sonnet: 0.9, anthropic_haiku: 0.8, anthropic_opus: 0.2},
    "scanner"            => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.5},
    "applier"            => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.4},
    "learner"            => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.5},
    "reflexion"          => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6, anthropic_opus: 0.3},
    "espl.crossover"     => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.5},
    "espl.mutation"      => %{anthropic_haiku: 1.0, anthropic_sonnet: 0.7},
    "self_rag.retrieve"  => %{anthropic_haiku: 1.0},
    "self_rag.relevance" => %{anthropic_haiku: 1.0},
    "principle.critique" => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.7, anthropic_opus: 0.5}
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

  # 룰 5+6: 작업 유형 (일반 + 연구 특화 research_affinity)

  # 연구 특화 task_type
  defp task_type_bias(:paper_analysis, model) do
    case model do
      :anthropic_sonnet -> 0.2
      :anthropic_opus   -> 0.4
      :anthropic_haiku  -> -0.2
    end
  end

  defp task_type_bias(:code_generation, model) do
    case model do
      :anthropic_sonnet -> 0.3
      :anthropic_opus   -> 0.1
      :anthropic_haiku  -> -0.2
    end
  end

  defp task_type_bias(:keyword_extraction, model) do
    case model do
      :anthropic_haiku  -> 0.3
      :anthropic_sonnet -> -0.1
      :anthropic_opus   -> -0.3
    end
  end

  defp task_type_bias(:evaluation_scoring, model) do
    case model do
      :anthropic_sonnet -> 0.2
      :anthropic_opus   -> 0.1
      :anthropic_haiku  -> 0.0
    end
  end

  # 일반 task_type
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
  # 룰 6: 정확도 요구 수준 (accuracy_bias) — 7차원
  # -------------------------------------------------------------------

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
    budget_ratio  = ctx[:budget_ratio]
    urgency       = ctx[:urgency]
    failure_rate  = ctx[:recent_failure_rate]
    prompt_tokens = ctx[:prompt_tokens]
    task_type     = ctx[:task_type]
    accuracy      = ctx[:accuracy]

    reasons = []
    reasons = if is_number(budget_ratio) and budget_ratio < 0.30, do: reasons ++ ["예산 부족"], else: reasons
    reasons = if urgency == :high, do: reasons ++ ["긴급"], else: reasons
    reasons = if is_number(failure_rate) and failure_rate > 0.15, do: reasons ++ ["실패율 높음"], else: reasons
    reasons = if is_integer(prompt_tokens) and prompt_tokens > 8_000, do: reasons ++ ["긴 컨텍스트"], else: reasons
    reasons = if accuracy in [:critical, :high], do: reasons ++ ["정확도 #{accuracy}"], else: reasons

    reasons =
      case task_type do
        :paper_analysis     -> reasons ++ ["논문 분석"]
        :code_generation    -> reasons ++ ["코드 생성"]
        :keyword_extraction -> reasons ++ ["키워드 추출"]
        :evaluation_scoring -> reasons ++ ["평가 채점"]
        _                   -> reasons
      end

    if reasons == [], do: "정책 권장", else: Enum.join(reasons, " / ")
  end
end
