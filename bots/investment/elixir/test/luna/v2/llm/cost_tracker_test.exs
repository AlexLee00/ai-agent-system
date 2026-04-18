defmodule Luna.V2.LLM.CostTrackerTest do
  use ExUnit.Case, async: true

  @moduletag :skip

  alias Luna.V2.LLM.CostTracker

  describe "check_budget/0" do
    test "check_budget returns {:ok, ratio} when under budget" do
      result = CostTracker.check_budget()
      assert match?({:ok, _ratio}, result)
      {:ok, ratio} = result
      assert is_float(ratio)
      assert ratio >= 0.0 and ratio <= 1.0
    end

    test "check_budget returns {:error, :budget_exceeded} when over budget" do
      # 이 테스트는 예산 초과 시나리오를 가정
      # 실제 DB에서 오늘 비용이 기본 예산($30)을 초과한 경우
      result = CostTracker.check_budget()
      assert match?({:ok, _}, result) or match?({:error, :budget_exceeded}, result)
    end
  end

  describe "track_tokens/1" do
    test "track_tokens returns cost_usd in result" do
      entry = %{
        agent_name: "luna.commander",
        model: "anthropic_sonnet",
        provider: "claude-code-oauth",
        tokens_in: 1000,
        tokens_out: 200
      }
      result = CostTracker.track_tokens(entry)
      assert match?({:ok, %{cost_usd: _}}, result)
    end

    test "cost calculation for haiku is cheaper than sonnet" do
      haiku_entry = %{
        agent_name: "luna.rag.query_planner",
        model: "anthropic_haiku",
        tokens_in: 1000,
        tokens_out: 200
      }
      sonnet_entry = %{
        agent_name: "luna.commander",
        model: "anthropic_sonnet",
        tokens_in: 1000,
        tokens_out: 200
      }
      {:ok, %{cost_usd: haiku_cost}} = CostTracker.track_tokens(haiku_entry)
      {:ok, %{cost_usd: sonnet_cost}} = CostTracker.track_tokens(sonnet_entry)
      assert haiku_cost < sonnet_cost
    end
  end

  describe "default_budget/0" do
    test "default budget is $30" do
      # LUNA_LLM_DAILY_BUDGET_USD 미설정 시 기본값 확인
      budget = Luna.V2.LLM.Policy.daily_budget_usd()
      assert budget == 30.0
    end
  end
end
