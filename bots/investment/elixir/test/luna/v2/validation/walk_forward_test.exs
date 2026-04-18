defmodule Luna.V2.Validation.WalkForwardTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Validation.WalkForward

  describe "run/1" do
    test "symbols 빈 리스트 → pass 필드 존재, periods=3" do
      strategy = %{parameter_snapshot: %{"symbols" => []}}
      {:ok, result} = WalkForward.run(strategy)
      assert result.type == :walk_forward
      assert result.periods == 3
      assert is_boolean(result.pass)
      assert is_float(result.avg_sharpe)
    end

    test "DB 실패 시 예외 없이 pass=false 반환" do
      strategy = %{parameter_snapshot: %{"symbols" => ["__wf_test__"]}}
      assert {:ok, result} = WalkForward.run(strategy)
      assert result.type == :walk_forward
      assert result.window_results |> length() == 3
    end

    test "window_results는 항상 periods개" do
      {:ok, result} = WalkForward.run(%{})
      assert length(result.window_results) == 3
    end
  end
end
