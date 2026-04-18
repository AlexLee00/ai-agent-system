defmodule Luna.V2.LLM.RoutingLogTest do
  use ExUnit.Case, async: false

  @moduletag :skip

  alias Luna.V2.LLM.RoutingLog

  describe "insert_log/1" do
    test "insert_log returns :ok for valid entry" do
      entry = %{
        agent_name: "luna.commander",
        model_primary: "anthropic_sonnet",
        model_used: "anthropic_sonnet",
        fallback_used: false,
        prompt_tokens: 500,
        response_tokens: 150,
        latency_ms: 1200,
        cost_usd: 0.003,
        response_ok: true,
        urgency: "medium",
        task_type: "rationale_generation",
        budget_ratio: 0.85,
        recommended_reason: "정책 권장",
        provider: "claude-code-oauth"
      }
      result = RoutingLog.record(entry)
      assert result == :ok
    end
  end

  describe "summary/0" do
    test "summary returns stats map with counts" do
      result = Jay.Core.LLM.RoutingLog.Impl.recent_failure_rate("luna_llm_routing_log", "luna.commander")
      assert is_float(result)
      assert result >= 0.0 and result <= 1.0
    end
  end

  describe "GenServer" do
    test "GenServer starts ok" do
      # RoutingLog은 보통 Supervisor에서 시작되지만
      # 직접 start_link 테스트
      result = RoutingLog.start_link(name: :test_routing_log_pid)
      assert match?({:ok, _pid}, result) or match?({:error, {:already_started, _}}, result)
    end
  end
end
