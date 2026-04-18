defmodule Luna.V2.LLM.SelectorTest do
  use ExUnit.Case, async: true

  # 테스트용 mock policy 모듈
  defmodule TestPolicy do
    @behaviour Jay.Core.LLM.Policy

    @impl true
    def agent_policies do
      %{
        "luna.commander"          => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
        "luna.rag.query_planner"  => %{route: :anthropic_haiku,  fallback: []},
      }
    end

    @impl true
    def default_policy, do: %{route: :anthropic_haiku, fallback: []}

    @impl true
    def agent_affinity do
      %{
        "luna.commander"         => %{anthropic_sonnet: 1.0, anthropic_haiku: 0.6},
        "luna.rag.query_planner" => %{anthropic_haiku: 1.0},
      }
    end

    @impl true
    def daily_budget_usd, do: 30.0

    @impl true
    def routing_log_table, do: "luna_llm_routing_log"

    @impl true
    def cost_tracking_table, do: "luna_llm_cost_tracking"

    @impl true
    def team_name, do: "luna"

    @impl true
    def log_prefix, do: "[루나V2-test]"

    @impl true
    def api_key, do: nil

    @impl true
    def hub_routing_enabled?, do: false

    @impl true
    def hub_shadow?, do: false
  end

  defmodule TestSelector do
    use Jay.Core.LLM.Selector, policy_module: Luna.V2.LLM.SelectorTest.TestPolicy
  end

  describe "policy_for/1" do
    test "루나 커맨더 → sonnet 정책 반환" do
      policy = TestSelector.policy_for("luna.commander")
      assert policy.route == :anthropic_sonnet
      assert :anthropic_haiku in policy.fallback
    end

    test "rag query planner → haiku 정책 반환" do
      policy = TestSelector.policy_for("luna.rag.query_planner")
      assert policy.route == :anthropic_haiku
      assert policy.fallback == []
    end

    test "미등록 에이전트 → default_policy (haiku) 반환" do
      policy = TestSelector.policy_for("unknown_luna_agent")
      assert policy.route == :anthropic_haiku
    end

    test "루나 principle.critique 미등록 시 default 반환" do
      policy = TestSelector.policy_for("luna.principle.critique")
      assert policy.route == :anthropic_haiku
    end
  end

  describe "call_with_fallback/3 — API 키 없는 환경" do
    test "api_key nil → {:error, _} 반환" do
      result = TestSelector.call_with_fallback("luna.commander", "투자 판단 요청", [])
      assert match?({:error, _}, result)
    end

    test "complete/3 → {:error, _} 반환 (api_key 없음)" do
      result = TestSelector.complete("luna.rag.query_planner", [%{role: "user", content: "test"}], [])
      assert match?({:error, _}, result)
    end
  end

  describe "Luna 특화 정책" do
    test "luna 팀명 확인" do
      assert TestPolicy.team_name() == "luna"
    end

    test "luna 기본 예산 $30" do
      assert TestPolicy.daily_budget_usd() == 30.0
    end
  end
end
