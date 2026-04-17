defmodule Sigma.V2.LLMTest do
  use ExUnit.Case, async: true

  @moduletag :llm

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
        for agent <- ["commander", "pod.risk", "pod.growth", "pod.trend",
                      "skill.data_quality", "skill.causal", "skill.experiment_design",
                      "skill.feature_planner", "skill.observability",
                      "principle.self_critique", "reflexion", "espl"],
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
    test "API 키 없으면 {:error, :all_routes_failed} 반환" do
      orig = System.get_env("ANTHROPIC_API_KEY")
      orig2 = System.get_env("SIGMA_ANTHROPIC_API_KEY")

      System.delete_env("ANTHROPIC_API_KEY")
      System.delete_env("SIGMA_ANTHROPIC_API_KEY")

      result = Sigma.V2.LLM.Selector.call_with_fallback(:reflexion, "test prompt")
      assert match?({:error, _}, result)

      if orig, do: System.put_env("ANTHROPIC_API_KEY", orig)
      if orig2, do: System.put_env("SIGMA_ANTHROPIC_API_KEY", orig2)
    end
  end

  describe "Sigma.V2.LLM.CostTracker.calculate_cost — 공개 가격 검증" do
    test "track_tokens/1는 {:ok, entry} 반환" do
      result = Sigma.V2.LLM.CostTracker.track_tokens(%{
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

    test "check_budget/0는 {:ok, _} 또는 {:error, :budget_exceeded} 반환" do
      result = Sigma.V2.LLM.CostTracker.check_budget()
      assert match?({:ok, %{daily: _, limit: _}}, result) or
               match?({:error, :budget_exceeded}, result)
    end
  end

  describe "Sigma.V2.LLM.Recommender.recommend/2" do
    test "컨텍스트 없으면 기본 정책 route 반환" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion")
      assert rec.route == :anthropic_sonnet
      assert is_binary(rec.reason)
    end

    test "예산 20% 미만이면 haiku 추천" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion", %{budget_remaining_pct: 0.1})
      assert rec.route == :anthropic_haiku
      assert rec.reason =~ "절약"
    end

    test "urgency: :high이면 haiku 추천 (속도 우선)" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("commander", %{urgency: :high})
      assert rec.route == :anthropic_haiku
      assert rec.reason =~ "긴급"
    end

    test "실패율 30% 초과면 opus 추천 (품질 강화)" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("reflexion", %{failure_rate: 0.4})
      assert rec.route == :anthropic_opus
      assert rec.reason =~ "실패율"
    end

    test "프롬프트 8000자 초과면 sonnet 추천" do
      {:ok, rec} = Sigma.V2.LLM.Recommender.recommend("pod.growth", %{prompt_len: 9_000})
      assert rec.route == :anthropic_sonnet
      assert rec.reason =~ "sonnet"
    end

    test "예산 우선순위 > 긴급도 (예산 부족 + 긴급 → haiku)" do
      {:ok, rec} =
        Sigma.V2.LLM.Recommender.recommend("reflexion", %{
          budget_remaining_pct: 0.05,
          urgency: :high
        })
      assert rec.route == :anthropic_haiku
    end

    test "미등록 에이전트도 {:ok, _} 반환" do
      result = Sigma.V2.LLM.Recommender.recommend("unknown.agent")
      assert match?({:ok, %{route: _, reason: _}}, result)
    end
  end
end
