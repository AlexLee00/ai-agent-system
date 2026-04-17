defmodule Sigma.V2.LLM.SelectorIntegrationTest do
  use ExUnit.Case, async: false

  alias Sigma.V2.LLM.Selector

  describe "call_with_fallback/3 — API 키 없는 환경" do
    test "API 키 없으면 모든 route 실패 → {:error, :all_routes_failed}" do
      orig  = System.get_env("ANTHROPIC_API_KEY")
      orig2 = System.get_env("SIGMA_ANTHROPIC_API_KEY")

      System.delete_env("ANTHROPIC_API_KEY")
      System.delete_env("SIGMA_ANTHROPIC_API_KEY")

      result = Selector.call_with_fallback(:reflexion, "test prompt")
      assert match?({:error, _}, result)

      if orig,  do: System.put_env("ANTHROPIC_API_KEY", orig)
      if orig2, do: System.put_env("SIGMA_ANTHROPIC_API_KEY", orig2)
    end
  end

  describe "call_with_fallback/3 — 예산 초과 시뮬레이션" do
    test "budget_exceeded 환경 — 원래 예산 임시 0으로 줄임" do
      # 환경변수로 예산을 0으로 설정하여 즉시 budget_exceeded 유발
      orig_budget = System.get_env("SIGMA_LLM_DAILY_BUDGET_USD")
      System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", "0.0")

      result = Selector.call_with_fallback(:reflexion, "test")
      # 예산 초과 or 폴백 실패 (둘 다 {error, _})
      assert match?({:error, _}, result)

      if orig_budget, do: System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", orig_budget),
                     else: System.delete_env("SIGMA_LLM_DAILY_BUDGET_USD")
    end
  end

  describe "policy_for/1" do
    test "reflexion → anthropic_sonnet" do
      policy = Selector.policy_for("reflexion")
      assert policy.route == :anthropic_sonnet
      assert :anthropic_haiku in policy.fallback
    end

    test "principle.self_critique → anthropic_opus" do
      policy = Selector.policy_for("principle.self_critique")
      assert policy.route == :anthropic_opus
    end

    test "미등록 에이전트 → haiku default" do
      policy = Selector.policy_for("unknown.agent.xyz")
      assert policy.route == :anthropic_haiku
    end

    test "Ollama route 없음 — Claude 전용 확인" do
      agents = [
        "commander", "pod.risk", "pod.growth", "pod.trend",
        "skill.data_quality", "skill.causal", "skill.experiment_design",
        "skill.feature_planner", "skill.observability",
        "principle.self_critique", "reflexion", "espl"
      ]

      for agent <- agents do
        policy = Selector.policy_for(agent)
        assert policy.route not in [:ollama_8b, :ollama_32b],
               "Ollama route가 남아있음: #{inspect(policy.route)} for #{agent}"
        for fb <- policy.fallback do
          assert fb not in [:ollama_8b, :ollama_32b],
                 "Ollama fallback이 남아있음: #{inspect(fb)} for #{agent}"
        end
      end
    end
  end

  describe "build_context (via call_with_fallback 간접 확인)" do
    test "call_with_fallback opts로 urgency/task_type 전달 가능" do
      orig  = System.get_env("ANTHROPIC_API_KEY")
      orig2 = System.get_env("SIGMA_ANTHROPIC_API_KEY")

      System.delete_env("ANTHROPIC_API_KEY")
      System.delete_env("SIGMA_ANTHROPIC_API_KEY")

      # 에러 반환되더라도 crash 없이 opts 처리됨 확인
      result = Selector.call_with_fallback(
        :reflexion, "prompt",
        urgency: :high, task_type: :structured_reasoning, max_tokens: 50
      )
      assert match?({:error, _}, result)

      if orig,  do: System.put_env("ANTHROPIC_API_KEY", orig)
      if orig2, do: System.put_env("SIGMA_ANTHROPIC_API_KEY", orig2)
    end
  end
end
