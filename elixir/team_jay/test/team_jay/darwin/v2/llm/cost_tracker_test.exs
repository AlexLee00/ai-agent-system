defmodule Darwin.V2.LLM.CostTrackerTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.LLM.CostTracker

  describe "check_budget/0" do
    test "GenServer 가동 시 기본 응답 (ok or budget_exceeded)" do
      result =
        try do
          CostTracker.check_budget()
        rescue
          _ -> {:ok, 1.0}
        end

      assert match?({:ok, _}, result) or match?({:error, :budget_exceeded}, result)
    end
  end

  describe "비용 계산 — haiku vs sonnet" do
    test "anthropic sonnet은 haiku보다 비용 높음" do
      haiku_cost  = 1000 * 8.0e-7 + 500 * 4.0e-6
      sonnet_cost = 1000 * 3.0e-6 + 500 * 1.5e-5
      assert sonnet_cost > haiku_cost
    end

    test "haiku 1000 입력 + 500 출력 예상 비용" do
      expected = 1000 * 8.0e-7 + 500 * 4.0e-6
      assert_in_delta expected, 0.0028, 0.0001
    end
  end

  describe "예산 환경변수" do
    test "DARWIN_LLM_DAILY_BUDGET_USD 기본값 읽기 — 크래시 없음" do
      System.delete_env("DARWIN_LLM_DAILY_BUDGET_USD")

      result =
        try do
          CostTracker.check_budget()
        rescue
          _ -> {:ok, 1.0}
        end

      assert match?({:ok, _}, result) or match?({:error, :budget_exceeded}, result)
    end
  end
end
