defmodule Jay.Core.LLM.SelectorTest do
  use ExUnit.Case, async: true

  # 테스트용 mock policy 모듈
  defmodule TestPolicy do
    @behaviour Jay.Core.LLM.Policy

    @impl true
    def agent_policies do
      %{
        "fast_agent" => %{route: :anthropic_haiku,  fallback: []},
        "smart_agent" => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
      }
    end

    @impl true
    def default_policy, do: %{route: :anthropic_haiku, fallback: []}

    @impl true
    def agent_affinity do
      %{"fast_agent" => %{tier: :fast}, "smart_agent" => %{tier: :smart}}
    end

    @impl true
    def daily_budget_usd, do: 10.0

    @impl true
    def routing_log_table, do: "test_routing_log"

    @impl true
    def cost_tracking_table, do: "test_cost_tracking"

    @impl true
    def team_name, do: "test_team"

    @impl true
    def log_prefix, do: "[test]"

    @impl true
    def api_key, do: nil

    @impl true
    def hub_routing_enabled?, do: false

    @impl true
    def hub_shadow?, do: false
  end

  defmodule TestRoutingLog do
    def record(_entry), do: :ok
    def recent_failure_rate(_agent), do: 0.0
  end

  defmodule TestCostTracker do
    def track_tokens(_entry), do: {:ok, %{cost_usd: 0.0}}
    def check_budget, do: {:ok, 1.0}
  end

  defmodule TestSelector do
    use Jay.Core.LLM.Selector, policy_module: Jay.Core.LLM.SelectorTest.TestPolicy
  end

  describe "policy_for/1" do
    test "등록된 에이전트 → 해당 정책 반환" do
      policy = TestSelector.policy_for("fast_agent")
      assert policy.route == :anthropic_haiku
    end

    test "등록된 에이전트 (sonnet) → 정확한 fallback 포함" do
      policy = TestSelector.policy_for("smart_agent")
      assert policy.route == :anthropic_sonnet
      assert :anthropic_haiku in policy.fallback
    end

    test "미등록 에이전트 → default_policy 반환" do
      policy = TestSelector.policy_for("unknown_agent_xyz")
      assert policy.route == :anthropic_haiku
    end

    test "atom 에이전트 이름도 처리" do
      policy = TestSelector.policy_for(:fast_agent)
      assert policy.route == :anthropic_haiku
    end
  end

  describe "call_with_fallback/3 — API 키 없는 환경" do
    test "api_key nil → {:error, _} 반환" do
      result = TestSelector.call_with_fallback("fast_agent", "test prompt", [])
      assert match?({:error, _}, result)
    end

    test "빈 프롬프트도 에러 처리" do
      result = TestSelector.call_with_fallback("fast_agent", "", [])
      assert match?({:error, _}, result)
    end
  end

  describe "Jay.Core.LLM.Policy behaviour" do
    test "TestPolicy가 모든 필수 콜백 구현" do
      assert function_exported?(TestPolicy, :agent_policies, 0)
      assert function_exported?(TestPolicy, :default_policy, 0)
      assert function_exported?(TestPolicy, :agent_affinity, 0)
      assert function_exported?(TestPolicy, :daily_budget_usd, 0)
      assert function_exported?(TestPolicy, :routing_log_table, 0)
      assert function_exported?(TestPolicy, :cost_tracking_table, 0)
      assert function_exported?(TestPolicy, :team_name, 0)
      assert function_exported?(TestPolicy, :log_prefix, 0)
      assert function_exported?(TestPolicy, :api_key, 0)
      assert function_exported?(TestPolicy, :hub_routing_enabled?, 0)
      assert function_exported?(TestPolicy, :hub_shadow?, 0)
    end

    test "kill_switch?/0 optional — TestPolicy에 없어도 됨" do
      refute function_exported?(TestPolicy, :kill_switch?, 0)
    end
  end
end
