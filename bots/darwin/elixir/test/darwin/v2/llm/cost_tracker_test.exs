defmodule Darwin.V2.LLM.CostTrackerTest do
  use ExUnit.Case

  test "check_budget/0 예산 미초과 시 {:ok, ratio} 반환" do
    assert {:ok, ratio} = Darwin.V2.LLM.CostTracker.check_budget()
    assert is_float(ratio) or is_integer(ratio)
    assert ratio >= 0.0
  end

  test "today_cost_usd/0 0.0 이상 반환" do
    cost = Darwin.V2.LLM.CostTracker.today_cost_usd()
    assert is_float(cost) or is_integer(cost)
    assert cost >= 0.0
  end

  test "track_tokens/1 로컬 모델은 비용 0" do
    before = Darwin.V2.LLM.CostTracker.today_cost_usd()
    Darwin.V2.LLM.CostTracker.track_tokens(%{
      agent: "test",
      model: "qwen2.5-7b",
      provider: "local",
      tokens_in: 1000,
      tokens_out: 500
    })
    :timer.sleep(50)
    after_cost = Darwin.V2.LLM.CostTracker.today_cost_usd()
    assert after_cost == before
  end
end
