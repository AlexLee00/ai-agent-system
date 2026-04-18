defmodule Luna.V2.MarketHoursGateTest do
  use ExUnit.Case, async: true

  alias Luna.V2.MarketHoursGate

  describe "crypto — 항상 활성" do
    test "crypto는 24/7 open" do
      assert MarketHoursGate.open?(:crypto) == true
    end

    test "crypto는 active_markets에 항상 포함" do
      assert :crypto in MarketHoursGate.active_markets()
    end

    test "crypto seconds_until_open = 0" do
      assert MarketHoursGate.seconds_until_open(:crypto) == 0
    end
  end

  describe "unknown market" do
    test "알 수 없는 시장 → false" do
      assert MarketHoursGate.open?(:unknown) == false
    end

    test "nil 시장 → false" do
      assert MarketHoursGate.open?(nil) == false
    end
  end

  describe "active_markets" do
    test "반환값은 리스트" do
      result = MarketHoursGate.active_markets()
      assert is_list(result)
    end

    test "반환값은 유효한 시장만 포함" do
      valid = [:crypto, :domestic, :overseas]
      result = MarketHoursGate.active_markets()
      assert Enum.all?(result, &(&1 in valid))
    end
  end

  describe "domestic/overseas — 함수 존재" do
    test "open?/1 domestic 처리 가능 (예외 없음)" do
      result = MarketHoursGate.open?(:domestic)
      assert is_boolean(result)
    end

    test "open?/1 overseas 처리 가능 (예외 없음)" do
      result = MarketHoursGate.open?(:overseas)
      assert is_boolean(result)
    end

    test "seconds_until_open/1 domestic — 음수 없음" do
      assert MarketHoursGate.seconds_until_open(:domestic) >= 0
    end

    test "seconds_until_open/1 overseas — 음수 없음" do
      assert MarketHoursGate.seconds_until_open(:overseas) >= 0
    end
  end
end
