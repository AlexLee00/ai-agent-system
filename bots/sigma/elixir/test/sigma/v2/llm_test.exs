defmodule Sigma.V2.LLMTest do
  use ExUnit.Case, async: false

  @moduletag :llm
  @llm_env_keys [
    "ANTHROPIC_API_KEY",
    "SIGMA_ANTHROPIC_API_KEY",
    "LLM_HUB_ROUTING_ENABLED",
    "LLM_HUB_ROUTING_SHADOW",
    "HUB_ENABLE_CLAUDE_PUBLIC_API",
    "HUB_ENABLE_ANTHROPIC_PUBLIC_API",
    "JAY_LLM_DIRECT_FALLBACK",
    "HUB_LLM_DIRECT_FALLBACK",
    "SIGMA_LLM_DIRECT_FALLBACK"
  ]

  describe "Sigma.V2.LLM.Selector.policy_for/1" do
    test "reflexion은 anthropic_sonnet 기본 policy" do
      policy = Sigma.V2.LLM.Selector.policy_for("reflexion")
      assert policy.route == :anthropic_sonnet
      assert :anthropic_haiku in policy.fallback
    end

    test "principle.self_critique는 anthropic_opus 기본 policy" do
      policy = Sigma.V2.LLM.Selector.policy_for("principle.self_critique")
      assert policy.route == :anthropic_opus
      assert :anthropic_sonnet in policy.fallback
    end

    test "espl은 anthropic_sonnet 기본 policy" do
      policy = Sigma.V2.LLM.Selector.policy_for("espl")
      assert policy.route == :anthropic_sonnet
    end

    test "미등록 에이전트는 default policy 반환" do
      policy = Sigma.V2.LLM.Selector.policy_for("unknown.agent.xyz")
      assert policy.route == :anthropic_haiku
    end

    test "Ollama route 없음 — Claude 전용 확인" do
      all_policies =
        for agent <- [
              "commander",
              "pod.risk",
              "pod.growth",
              "pod.trend",
              "skill.data_quality",
              "skill.causal",
              "skill.experiment_design",
              "skill.feature_planner",
              "skill.observability",
              "principle.self_critique",
              "reflexion",
              "espl"
            ],
            do: Sigma.V2.LLM.Selector.policy_for(agent)

      for policy <- all_policies do
        assert policy.route not in [:ollama_8b, :ollama_32b],
               "Ollama route가 남아있음: #{inspect(policy.route)}"

        for fb <- policy.fallback do
          assert fb not in [:ollama_8b, :ollama_32b],
                 "Ollama fallback이 남아있음: #{inspect(fb)}"
        end
      end
    end
  end

  describe "Sigma.V2.LLM.Selector.call_with_fallback/3 — API 키 없는 환경" do
    test "API 키 없으면 {:error, _} 반환" do
      without_env(@llm_env_keys, fn ->
        assert {:error, :llm_routing_unavailable} =
                 Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, "test prompt")
      end)
    end
  end

  describe "Sigma.V2.LLM.CostTracker" do
    @tag :skip
    test "track_tokens/1는 {:ok, entry} 반환" do
      result =
        Sigma.V2.LLM.CostTracker.track_tokens(%{
          agent: "reflexion",
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          tokens_in: 100,
          tokens_out: 50
        })

      assert match?({:ok, %{cost_usd: _}}, result)
      {:ok, entry} = result
      assert entry.cost_usd > 0
    end

    @tag :skip
    test "check_budget/0는 {:ok, ratio} 또는 {:error, :budget_exceeded} 반환" do
      result = Sigma.V2.LLM.CostTracker.check_budget()

      assert match?({:ok, r} when is_float(r), result) or
               match?({:error, :budget_exceeded}, result)
    end
  end

  describe "Sigma.V2.LLM.Recommender.recommend/2 — 신규 6-rule 인터페이스" do
    test "기본 컨텍스트 없으면 {:ok, %{primary, fallback, reason, scores}} 반환" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion")
      assert rec.primary == :anthropic_sonnet
      assert is_binary(rec.reason)
      assert is_list(rec.fallback)
      assert is_list(rec.scores)
    end

    test "budget_ratio 0.05 → haiku 추천 (예산 부족)" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion", %{budget_ratio: 0.05})
      assert rec.primary == :anthropic_haiku
      assert rec.reason =~ "예산"
    end

    test "urgency :high → haiku 추천 (속도 우선)" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("commander", %{urgency: :high})
      assert rec.primary == :anthropic_haiku
      assert rec.reason =~ "긴급"
    end

    test "높은 실패율 → scores에 패널티 반영" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion", %{recent_failure_rate: 0.5})

      # 모든 모델에 -0.8 패널티, reflexion은 여전히 sonnet base가 높음 (1.0-0.8=0.2)
      assert rec.primary == :anthropic_sonnet
    end

    test "미등록 에이전트도 {:ok, _} 반환" do
      result = Sigma.V2.LLM.Recommender.recommend("unknown.agent")
      assert match?({:ok, %{primary: _, reason: _, fallback: _}}, result)
    end

    test "prompt_tokens 10000 → 긴 컨텍스트 이유 포함" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion", %{prompt_tokens: 10_000})
      assert rec.reason =~ "컨텍스트"
    end
  end

  defp without_env(keys, fun) do
    previous = Map.new(keys, &{&1, System.get_env(&1)})
    Enum.each(keys, &System.delete_env/1)

    try do
      fun.()
    after
      Enum.each(previous, fn
        {key, nil} -> System.delete_env(key)
        {key, value} -> System.put_env(key, value)
      end)
    end
  end
end
