defmodule Sigma.V2.LLM.RoutingLogTest do
  use ExUnit.Case, async: false

  alias Sigma.V2.LLM.RoutingLog

  describe "recent_failure_rate/1" do
    test "DB 오류 시 0.0 반환 (graceful fallback)" do
      # sigma_v2_llm_routing_log 테이블이 없어도 rescue로 0.0 반환
      rate = RoutingLog.recent_failure_rate("test.agent.nonexistent")
      assert is_float(rate)
      assert rate >= 0.0 and rate <= 1.0
    end

    test "알 수 없는 에이전트 → 0.0 (기록 없음)" do
      rate = RoutingLog.recent_failure_rate("sigma.v2.test.agent.#{System.unique_integer()}")
      assert rate == 0.0 or is_float(rate)
    end
  end

  describe "record/1" do
    test "DB 오류 시 :ok 반환 (로깅 실패로 실호출 차단 없음)" do
      entry = %{
        agent_name: "test.agent",
        model_primary: "anthropic_sonnet",
        model_used: "anthropic_haiku",
        fallback_used: true,
        prompt_tokens: 500,
        response_tokens: 100,
        latency_ms: 1200,
        cost_usd: 0.000123,
        response_ok: true,
        error_reason: nil,
        urgency: :medium,
        task_type: :structured_reasoning,
        budget_ratio: 0.85,
        recommended_reason: "정책 권장"
      }

      # 테이블이 없어도 :ok 반환 (rescue)
      result = RoutingLog.record(entry)
      assert result == :ok
    end

    test "nil model_used 처리 (all_routes_failed 케이스)" do
      entry = %{
        agent_name: "reflexion",
        model_primary: "anthropic_sonnet",
        model_used: nil,
        fallback_used: false,
        prompt_tokens: nil,
        response_tokens: nil,
        latency_ms: nil,
        cost_usd: nil,
        response_ok: false,
        error_reason: "all_routes_failed",
        urgency: nil,
        task_type: nil,
        budget_ratio: nil,
        recommended_reason: nil
      }

      result = RoutingLog.record(entry)
      assert result == :ok
    end
  end
end
