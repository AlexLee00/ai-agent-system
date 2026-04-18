defmodule Jay.Core.LLM.CostTrackerTest do
  use ExUnit.Case, async: true

  alias Jay.Core.LLM.CostTracker

  describe "calculate_cost/3" do
    test "haiku 1000 in + 500 out → 정확한 비용" do
      # 1000 * 0.8e-6 + 500 * 4.0e-6 = 0.0008 + 0.002 = 0.0028
      cost = CostTracker.calculate_cost("claude-haiku-4-5-20251001", 1_000, 500)
      assert_in_delta cost, 0.0028, 0.000001
    end

    test "sonnet 1000 in + 500 out → 정확한 비용" do
      # 1000 * 3.0e-6 + 500 * 15.0e-6 = 0.003 + 0.0075 = 0.0105
      cost = CostTracker.calculate_cost("claude-sonnet-4-6", 1_000, 500)
      assert_in_delta cost, 0.0105, 0.000001
    end

    test "opus 1000 in + 500 out → 정확한 비용" do
      # 1000 * 15.0e-6 + 500 * 75.0e-6 = 0.015 + 0.0375 = 0.0525
      cost = CostTracker.calculate_cost("claude-opus-4-7", 1_000, 500)
      assert_in_delta cost, 0.0525, 0.000001
    end

    test "미등록 모델 → 0.0" do
      cost = CostTracker.calculate_cost("unknown-model-xyz", 1_000, 500)
      assert cost == 0.0
    end

    test "토큰 0개 → 비용 0.0" do
      cost = CostTracker.calculate_cost("claude-haiku-4-5-20251001", 0, 0)
      assert cost == 0.0
    end

    test "output만 있을 때 비용 계산" do
      # output 1000 haiku: 1000 * 4.0e-6 = 0.004
      cost = CostTracker.calculate_cost("claude-haiku-4-5-20251001", 0, 1_000)
      assert_in_delta cost, 0.004, 0.000001
    end

    test "input만 있을 때 비용 계산" do
      # input 1000 haiku: 1000 * 0.8e-6 = 0.0008
      cost = CostTracker.calculate_cost("claude-haiku-4-5-20251001", 1_000, 0)
      assert_in_delta cost, 0.0008, 0.000001
    end

    test "opus가 haiku보다 비쌈 (같은 토큰 수)" do
      haiku_cost = CostTracker.calculate_cost("claude-haiku-4-5-20251001", 1_000, 1_000)
      opus_cost  = CostTracker.calculate_cost("claude-opus-4-7", 1_000, 1_000)
      assert opus_cost > haiku_cost
    end
  end
end
