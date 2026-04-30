defmodule Luna.V2.Agents.AriaTest do
  use ExUnit.Case, async: false

  alias Luna.V2.Agents.Aria
  alias Luna.V2.Memory.WorkingMemory

  setup do
    ensure_memory()
    :ok
  end

  test "score returns deterministic shadow technical snapshot" do
    result =
      Aria.score(%{
        rsi: 28,
        macd_histogram: 0.8,
        bb_position: 0.1,
        timeframes: %{m15: :bullish, h1: :bullish, h4: :neutral}
      })

    assert result.agent == "aria"
    assert result.shadow == true
    assert result.mutate == false
    assert result.direction == :bullish_watch
  end

  test "GenServer tick writes latest snapshot to working memory" do
    name = :"aria_test_#{System.unique_integer([:positive])}"
    start_supervised!({Aria, name: name, auto_tick: false})
    result = Aria.tick(name, %{rsi: 80, macd_histogram: -0.7, bb_position: 0.95})
    assert result.direction == :bearish_watch
    assert {:ok, memory} = WorkingMemory.get("agent:aria:latest")
    assert memory.agent == "aria"
  end

  defp ensure_memory do
    case Process.whereis(WorkingMemory) do
      nil -> start_supervised!(WorkingMemory)
      _pid -> :ok
    end
  end
end
