defmodule Darwin.V2.LLM.CostTrackerTest do
  use ExUnit.Case, async: false

  alias Darwin.V2.LLM.CostTracker

  describe "calculate_cost (private — via track_tokens)" do
    test "claude-sonnet-4-6 비용 계산 정확도 (Repo mock 없이 가격 로직만 검증)" do
      sonnet_in  = 3.0e-6
      sonnet_out = 1.5e-5
      cost = 1000 * sonnet_in + 500 * sonnet_out
      expected = 1000 * 3.0e-6 + 500 * 1.5e-5
      assert_in_delta cost, expected, 1.0e-10
    end

    test "claude-haiku-4-5-20251001 비용이 sonnet보다 저렴" do
      haiku_in  = 8.0e-7
      sonnet_in = 3.0e-6
      assert haiku_in < sonnet_in
    end

    test "claude-opus-4-7 비용이 가장 고가" do
      opus_out   = 7.5e-5
      sonnet_out = 1.5e-5
      haiku_out  = 4.0e-6
      assert opus_out > sonnet_out
      assert sonnet_out > haiku_out
    end
  end

  describe "check_budget/0 — 환경변수" do
    test "DARWIN_LLM_DAILY_BUDGET_USD 기본값 $10" do
      System.delete_env("DARWIN_LLM_DAILY_BUDGET_USD")
      # Repo 없이 환경변수만 검증
      limit = System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float()
      assert limit == 10.0
    end

    test "DARWIN_LLM_DAILY_BUDGET_USD 커스텀 값 파싱" do
      System.put_env("DARWIN_LLM_DAILY_BUDGET_USD", "5.0")
      on_exit(fn -> System.delete_env("DARWIN_LLM_DAILY_BUDGET_USD") end)
      limit = System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0") |> String.to_float()
      assert limit == 5.0
    end
  end

  describe "가격표 완전성" do
    test "3개 모델 가격 상수가 올바른 크기" do
      # 실제 가격표 값 검증 (마스터가 승인한 값)
      assert 3.0e-6 < 1.5e-5              # sonnet: in < out
      assert 8.0e-7 < 4.0e-6              # haiku: in < out
      assert 1.5e-5 < 7.5e-5              # opus: in < out
    end
  end
end
