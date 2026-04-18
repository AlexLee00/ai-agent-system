defmodule Luna.V2.Validation.BacktestTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Validation.Backtest

  describe "calc_sharpe/2" do
    test "정상 계산" do
      sharpe = Backtest.calc_sharpe(0.01, 0.02)
      assert sharpe > 0
    end

    test "stdev 0이면 avg>0 → 99.0" do
      assert Backtest.calc_sharpe(0.5, 0.0) == 99.0
    end

    test "stdev 0 & avg 0 → 0.0" do
      assert Backtest.calc_sharpe(0.0, 0.0) == 0.0
    end

    test "음수 avg → 음수 sharpe" do
      sharpe = Backtest.calc_sharpe(-0.01, 0.02)
      assert sharpe < 0
    end
  end

  describe "run/1 — DB 접근 없는 경계값" do
    test "symbols 빈 리스트 → empty result" do
      strategy = %{parameter_snapshot: %{"symbols" => []}}
      {:ok, result} = Backtest.run(strategy)
      assert result.type == :backtest
      assert result.trades == 0
      assert result.sharpe == 0.0
    end

    test "parameter_snapshot 없음 → empty result" do
      {:ok, result} = Backtest.run(%{})
      assert result.type == :backtest
      assert result.trades == 0
    end

    test "DB 실패 시 예외 없이 empty result 반환" do
      # 존재하지 않는 테이블 심볼로 DB 오류 유발 (실제 DB 없는 환경)
      strategy = %{parameter_snapshot: %{"symbols" => ["__nonexistent__"]}}
      assert {:ok, result} = Backtest.run(strategy)
      assert result.type == :backtest
    end
  end
end
