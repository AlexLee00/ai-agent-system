defmodule Sigma.V2.LLM.SelectorIntegrationTest do
  use ExUnit.Case, async: false

  alias Sigma.V2.LLM.Selector

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

  describe "call_with_fallback/3 — API 키 없는 환경" do
    test "API 키와 Hub route가 없으면 routing unavailable을 반환" do
      without_env(@llm_env_keys, fn ->
        assert {:error, :llm_routing_unavailable} =
                 Selector.call_with_fallback(:reflexion, "test prompt")
      end)
    end
  end

  describe "call_with_fallback/3 — 예산 초과 시뮬레이션" do
    test "budget_exceeded 환경 — 원래 예산 임시 0으로 줄임" do
      with_env(
        Map.merge(clear_llm_env(), %{
          "LLM_HUB_ROUTING_ENABLED" => "true",
          "SIGMA_LLM_DAILY_BUDGET_USD" => "0.0"
        }),
        fn ->
          assert {:error, :budget_exceeded} = Selector.call_with_fallback(:reflexion, "test")
        end
      )
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
      without_env(@llm_env_keys, fn ->
        assert {:error, :llm_routing_unavailable} =
                 Selector.call_with_fallback(
                   :reflexion,
                   "prompt",
                   urgency: :high,
                   task_type: :structured_reasoning,
                   max_tokens: 50
                 )
      end)
    end
  end

  defp clear_llm_env do
    Map.new(@llm_env_keys, &{&1, nil})
  end

  defp without_env(keys, fun) do
    keys
    |> Map.new(&{&1, nil})
    |> with_env(fun)
  end

  defp with_env(values, fun) do
    previous = Map.new(Map.keys(values), &{&1, System.get_env(&1)})

    Enum.each(values, fn
      {key, nil} -> System.delete_env(key)
      {key, value} -> System.put_env(key, value)
    end)

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
