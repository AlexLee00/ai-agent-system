defmodule Luna.V2.PolicyEnginesTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Policy.{
    HardRuleEngine,
    AdaptiveRiskEngine,
    BudgetPolicyEngine,
    ReentryPolicyEngine,
    ExposurePolicyEngine
  }

  describe "HardRuleEngine" do
    test "notional 하한 미달 차단" do
      candidate = %{symbol: "BTCUSDT", market: :crypto, amount_krw: 5_000}
      assert {:error, :min_order_notional, _} = HardRuleEngine.check(candidate)
    end

    test "notional 상한 초과 차단" do
      candidate = %{symbol: "BTCUSDT", market: :crypto, amount_krw: 6_000_000}
      assert {:error, :max_order_notional, _} = HardRuleEngine.check(candidate)
    end

    test "블랙리스트 심볼 차단" do
      candidate = %{symbol: "LUNA2", market: :crypto, amount_krw: 100_000}
      assert {:error, :blacklisted_symbol, _} = HardRuleEngine.check(candidate)
    end

    test "잔고 부족 차단" do
      candidate = %{symbol: "BTCUSDT", market: :crypto, amount_krw: 500_000}
      context = %{available_krw: 100_000}
      assert {:error, :insufficient_balance, _} = HardRuleEngine.check(candidate, context)
    end

    test "정상 후보 통과" do
      candidate = %{symbol: "BTCUSDT", market: :crypto, amount_krw: 100_000}
      assert {:ok, :passed} = HardRuleEngine.check(candidate)
    end
  end

  describe "AdaptiveRiskEngine" do
    test "calm regime = 1.2 배율" do
      candidate = %{symbol: "BTCUSDT", amount_krw: 100_000, amount_usd: 100}
      context = %{vix: 12.0, fear_and_greed: 70, volatility_1d: 0.01}
      {:ok, adjusted} = AdaptiveRiskEngine.adjust(candidate, context)
      assert adjusted.regime == :calm
      assert adjusted.amount_krw == 120_000
    end

    test "extreme regime = 0.3 배율" do
      candidate = %{symbol: "BTCUSDT", amount_krw: 100_000, amount_usd: 100}
      context = %{vix: 45.0, fear_and_greed: 10, volatility_1d: 0.1}
      {:ok, adjusted} = AdaptiveRiskEngine.adjust(candidate, context)
      assert adjusted.regime == :extreme
      assert adjusted.amount_krw == 30_000
    end

    test "regime 감지 — volatile" do
      regime = AdaptiveRiskEngine.detect_regime(%{vix: 28, fear_and_greed: 20, volatility_1d: 0.06})
      assert regime == :volatile
    end
  end

  describe "ExposurePolicyEngine" do
    test "포트폴리오 없을 때 통과" do
      candidate = %{symbol: "BTCUSDT", market: :crypto, amount_krw: 100_000}
      assert {:ok, :passed} = ExposurePolicyEngine.check(candidate, %{total_value_krw: 10_000_000})
    end
  end

  describe "MarketHoursGate" do
    test "crypto는 항상 open" do
      assert Luna.V2.MarketHoursGate.open?(:crypto) == true
    end

    test "active_markets에 crypto 포함" do
      markets = Luna.V2.MarketHoursGate.active_markets()
      assert :crypto in markets
    end
  end
end
