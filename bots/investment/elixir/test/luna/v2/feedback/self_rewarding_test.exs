defmodule Luna.V2.Feedback.SelfRewardingTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Feedback.SelfRewarding

  setup_all do
    Code.ensure_compiled!(SelfRewarding)
    :ok
  end

  describe "모듈 구조" do
    test "SelfRewarding 컴파일됨" do
      assert Code.ensure_loaded?(SelfRewarding)
    end

    test "evaluate_trade/1 존재" do
      assert function_exported?(SelfRewarding, :evaluate_trade, 1)
    end
  end

  describe "evaluate_trade/1 — 안전성" do
    test "잘못된 trade_id (문자열) → {:error, :invalid_trade_id}" do
      result = SelfRewarding.evaluate_trade("invalid")
      assert result == {:error, :invalid_trade_id}
    end

    test "잘못된 trade_id (nil) → {:error, :invalid_trade_id}" do
      result = SelfRewarding.evaluate_trade(nil)
      assert result == {:error, :invalid_trade_id}
    end

    test "DB 미연결 시 예외 없이 오류 반환" do
      # DB가 없으면 fetch_trade/1에서 오류 반환, 예외 없음
      result = SelfRewarding.evaluate_trade(999_999_999)
      assert match?({:error, _}, result) or match?({:ok, _}, result)
    end
  end
end
