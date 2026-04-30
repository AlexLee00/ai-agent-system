defmodule Luna.V2.Agents.StockFlowTest do
  use ExUnit.Case, async: false

  alias Luna.V2.Agents.StockFlow
  alias Luna.V2.Memory.WorkingMemory

  setup do
    ensure_memory()
    :ok
  end

  test "analyze returns shadow BUY watch without mutation" do
    result = StockFlow.analyze(%{volume_ratio: 3.0, quote_change_pct: 0.5, scout_score: 0.8})
    assert result.agent == "stock-flow"
    assert result.shadow == true
    assert result.mutate == false
    assert result.signal == :BUY
  end

  test "GenServer tick writes latest snapshot to working memory" do
    name = :"stock_flow_test_#{System.unique_integer([:positive])}"
    start_supervised!({StockFlow, name: name, auto_tick: false})
    result = StockFlow.tick(name, %{volume_ratio: 0.2, quote_change_pct: -0.6})
    assert result.pressure == :distribution_watch
    assert {:ok, memory} = WorkingMemory.get("agent:stock-flow:latest")
    assert memory.agent == "stock-flow"
  end

  defp ensure_memory do
    case Process.whereis(WorkingMemory) do
      nil -> start_supervised!(WorkingMemory)
      _pid -> :ok
    end
  end
end
