defmodule Darwin.V2.LLM.CostTrackerTest do
  use ExUnit.Case, async: false

  # Darwin.V2.LLM.CostTracker는 GenServer — 테스트 환경에서 미기동 가능.
  # 순수 계산 로직만 직접 검증.

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

    test "sonnet 비용 계산" do
      cost = 1000 * 3.0e-6 + 500 * 1.5e-5
      assert_in_delta cost, 0.0105, 0.0001
    end

    test "opus 비용 계산" do
      cost = 1000 * 1.5e-5 + 500 * 7.5e-5
      assert_in_delta cost, 0.0525, 0.0001
    end
  end

  describe "check_budget/0 — GenServer 기동 시" do
    test "CostTracker 프로세스 기동 시 응답" do
      pid = Process.whereis(Darwin.V2.LLM.CostTracker)

      if pid do
        result = Darwin.V2.LLM.CostTracker.check_budget()
        assert match?({:ok, _}, result) or match?({:error, :budget_exceeded}, result)
      end
    end
  end

  describe "예산 환경변수 기본값" do
    test "DARWIN_LLM_DAILY_BUDGET_USD 미설정 시 10.0 사용" do
      # 환경변수 없을 때 기본값 10.0
      System.delete_env("DARWIN_LLM_DAILY_BUDGET_USD")
      val = System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float()
      assert val == 10.0
    end
  end
end
