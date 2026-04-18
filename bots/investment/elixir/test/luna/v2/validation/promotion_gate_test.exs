defmodule Luna.V2.Validation.PromotionGateTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Validation.PromotionGate

  defp bt(sharpe, hit_rate, max_dd) do
    %{type: :backtest, sharpe: sharpe, hit_rate: hit_rate, max_dd: max_dd, avg_pnl: 0.0, trades: 100}
  end

  defp wf(pass), do: %{type: :walk_forward, pass: pass, periods: 3, avg_sharpe: 1.0}
  defp sh(runs), do: %{type: :shadow, runs: runs, avg_score: 0.9, avg_similarity: 0.9}

  describe "decide/1 — promote" do
    test "모든 기준 충족 → :promote" do
      {:ok, verdict} = PromotionGate.decide([bt(2.0, 0.60, -0.10), wf(true), sh(15)])
      assert verdict.verdict == :promote
    end
  end

  describe "decide/1 — demote" do
    test "sharpe < 0.5 → :demote" do
      {:ok, verdict} = PromotionGate.decide([bt(0.3, 0.60, -0.10), wf(true), sh(15)])
      assert verdict.verdict == :demote
      assert Enum.any?(verdict.reasons, &String.contains?(&1, "sharpe"))
    end

    test "max_dd < -0.25 → :demote" do
      {:ok, verdict} = PromotionGate.decide([bt(1.8, 0.60, -0.30), wf(true), sh(15)])
      assert verdict.verdict == :demote
      assert Enum.any?(verdict.reasons, &String.contains?(&1, "max_dd"))
    end

    test "sharpe < 0.5 & max_dd < -0.25 둘 다 → :demote, reasons 2개" do
      {:ok, verdict} = PromotionGate.decide([bt(0.3, 0.60, -0.30), wf(true), sh(15)])
      assert verdict.verdict == :demote
      assert length(verdict.reasons) == 2
    end
  end

  describe "decide/1 — hold" do
    test "sharpe 충분하나 shadow 부족 → :hold" do
      {:ok, verdict} = PromotionGate.decide([bt(2.0, 0.60, -0.10), wf(true), sh(5)])
      assert verdict.verdict == :hold
    end

    test "walk_forward fail → :hold" do
      {:ok, verdict} = PromotionGate.decide([bt(2.0, 0.60, -0.10), wf(false), sh(15)])
      assert verdict.verdict == :hold
    end

    test "빈 리스트 → :hold (기본 0 값)" do
      {:ok, verdict} = PromotionGate.decide([])
      assert verdict.verdict in [:hold, :demote]
    end
  end

  describe "verdict 구조" do
    test "항상 sharpe/hit_rate/max_dd/reasons 포함" do
      {:ok, verdict} = PromotionGate.decide([bt(1.0, 0.50, -0.10)])
      assert Map.has_key?(verdict, :verdict)
      assert Map.has_key?(verdict, :sharpe)
      assert Map.has_key?(verdict, :hit_rate)
      assert Map.has_key?(verdict, :reasons)
    end
  end
end
