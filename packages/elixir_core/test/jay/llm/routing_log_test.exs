defmodule Jay.Core.LLM.RoutingLogTest do
  use ExUnit.Case, async: true

  defmodule TestLog do
    use Jay.Core.LLM.RoutingLog,
      table: "test_routing_log",
      log_prefix: "[test/routing_log]"
  end

  describe "record/1" do
    test "응답 OK 항목 — DB 없어도 에러 없음" do
      entry = %{
        agent_name: "test_agent",
        model_primary: "anthropic_haiku",
        model_used: "anthropic_haiku",
        fallback_used: false,
        prompt_tokens: 100,
        response_tokens: 50,
        latency_ms: 120,
        cost_usd: 0.00012,
        response_ok: true,
        error_reason: nil,
        urgency: :medium,
        task_type: :structured_reasoning,
        budget_ratio: 0.1,
        recommended_reason: "affinity",
        provider: "claude-code-oauth"
      }

      result = TestLog.record(entry)
      assert result == :ok
    end

    test "실패 항목 (response_ok: false) — 에러 없음" do
      entry = %{
        agent_name: "test_agent",
        model_primary: "anthropic_haiku",
        model_used: "anthropic_haiku",
        fallback_used: false,
        latency_ms: 5000,
        cost_usd: 0.0,
        response_ok: false,
        error_reason: "timeout"
      }

      result = TestLog.record(entry)
      assert result == :ok
    end

    test "폴백 항목 — fallback_used: true" do
      entry = %{
        agent_name: "slow_agent",
        model_primary: "anthropic_sonnet",
        model_used: "anthropic_haiku",
        fallback_used: true,
        latency_ms: 300,
        cost_usd: 0.00008,
        response_ok: true,
        error_reason: nil,
        provider: "groq"
      }

      result = TestLog.record(entry)
      assert result == :ok
    end

    test "빈 entry — 에러 없음" do
      result = TestLog.record(%{})
      assert result == :ok
    end

    test "최소 필드 entry" do
      result = TestLog.record(%{agent_name: "minimal_agent", response_ok: true})
      assert result == :ok
    end
  end

  describe "recent_failure_rate/1" do
    test "DB 없어도 0.0 반환" do
      rate = TestLog.recent_failure_rate("test_agent")
      assert is_float(rate)
      assert rate >= 0.0 and rate <= 1.0
    end

    test "알 수 없는 에이전트 — 0.0" do
      rate = TestLog.recent_failure_rate("nonexistent_agent_xyz_123")
      assert rate == 0.0
    end
  end

  describe "use macro 주입 확인" do
    test "record/1 함수 존재" do
      assert function_exported?(TestLog, :record, 1)
    end

    test "recent_failure_rate/1 함수 존재" do
      assert function_exported?(TestLog, :recent_failure_rate, 1)
    end
  end
end
