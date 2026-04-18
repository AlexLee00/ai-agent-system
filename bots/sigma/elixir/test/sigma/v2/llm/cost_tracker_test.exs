defmodule Sigma.V2.LLM.CostTrackerTest do
  use ExUnit.Case, async: false

  # Jay.Core.Repo가 시작되지 않은 테스트 환경에서 DB 접근 불가
  @moduletag :skip

  alias Sigma.V2.LLM.CostTracker

  describe "check_budget/0" do
    test "{:ok, ratio} 또는 {:error, :budget_exceeded} 반환" do
      result = CostTracker.check_budget()
      assert match?({:ok, r} when is_float(r), result) or
               match?({:error, :budget_exceeded}, result)
    end

    test "정상 예산 환경 → {:ok, ratio} where 0.0 <= ratio <= 1.0" do
      # 충분히 큰 예산으로 설정하여 budget_exceeded 방지
      orig = System.get_env("SIGMA_LLM_DAILY_BUDGET_USD")
      System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", "9999.0")

      case CostTracker.check_budget() do
        {:ok, ratio} ->
          assert is_float(ratio)
          assert ratio >= 0.0 and ratio <= 1.0
        {:error, :budget_exceeded} ->
          # 극히 드물지만 오늘 이미 9999$ 초과면 허용
          :ok
      end

      if orig, do: System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", orig),
              else: System.delete_env("SIGMA_LLM_DAILY_BUDGET_USD")
    end

    test "budget_usd 0.0 설정 → {:error, :budget_exceeded}" do
      orig = System.get_env("SIGMA_LLM_DAILY_BUDGET_USD")
      System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", "0.0")

      result = CostTracker.check_budget()
      assert match?({:error, :budget_exceeded}, result)

      if orig, do: System.put_env("SIGMA_LLM_DAILY_BUDGET_USD", orig),
              else: System.delete_env("SIGMA_LLM_DAILY_BUDGET_USD")
    end
  end

  describe "track_tokens/1 — 비용 계산 정확도" do
    test "haiku 1000 in + 500 out → 약 $0.00282" do
      result = CostTracker.track_tokens(%{
        agent: "test.agent",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        tokens_in: 1_000,
        tokens_out: 500
      })
      # 비용: 1000*0.8e-6 + 500*4.0e-6 = 0.0008 + 0.002 = 0.0028
      assert match?({:ok, %{cost_usd: _}}, result)
      {:ok, entry} = result
      assert entry.cost_usd > 0.0
      assert_in_delta entry.cost_usd, 0.0028, 0.00001
    end

    test "sonnet 비용 계산 정확도" do
      result = CostTracker.track_tokens(%{
        agent: "reflexion",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        tokens_in: 1_000,
        tokens_out: 500
      })
      # 비용: 1000*3.0e-6 + 500*15.0e-6 = 0.003 + 0.0075 = 0.0105
      assert match?({:ok, %{cost_usd: _}}, result)
      {:ok, entry} = result
      assert_in_delta entry.cost_usd, 0.0105, 0.00001
    end

    test "opus 비용 계산 정확도" do
      result = CostTracker.track_tokens(%{
        agent: "principle.self_critique",
        model: "claude-opus-4-7",
        provider: "anthropic",
        tokens_in: 1_000,
        tokens_out: 500
      })
      # 비용: 1000*15.0e-6 + 500*75.0e-6 = 0.015 + 0.0375 = 0.0525
      assert match?({:ok, %{cost_usd: _}}, result)
      {:ok, entry} = result
      assert_in_delta entry.cost_usd, 0.0525, 0.00001
    end

    test "미등록 모델 → cost_usd 0.0" do
      result = CostTracker.track_tokens(%{
        agent: "test",
        model: "unknown-model-xyz",
        provider: "unknown",
        tokens_in: 100,
        tokens_out: 50
      })
      assert match?({:ok, %{cost_usd: 0.0}}, result)
    end
  end
end
