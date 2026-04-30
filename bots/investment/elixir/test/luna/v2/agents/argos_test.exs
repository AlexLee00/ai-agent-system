defmodule Luna.V2.Agents.ArgosTest do
  use ExUnit.Case, async: false

  alias Luna.V2.Agents.Argos
  alias Luna.V2.Memory.WorkingMemory

  setup do
    ensure_memory()
    :ok
  end

  test "screen scores candidates in descending order" do
    result =
      Argos.screen([
        %{symbol: "WEAK", score: 0.2, confidence: 0.2, liquidity_score: 0.2},
        %{symbol: "STRONG", score: 0.9, confidence: 0.9, liquidity_score: 0.8}
      ])

    assert result.agent == "argos"
    assert result.shadow == true
    assert result.mutate == false
    assert hd(result.candidates).symbol == "STRONG"
    assert result.accepted == 1
  end

  test "GenServer tick writes latest snapshot to working memory" do
    name = :"argos_test_#{System.unique_integer([:positive])}"
    start_supervised!({Argos, name: name, auto_tick: false})
    result = Argos.tick(name, [%{symbol: "BTC/USDT", score: 0.8, confidence: 0.8}])
    assert result.count == 1
    assert {:ok, memory} = WorkingMemory.get("agent:argos:latest")
    assert memory.agent == "argos"
  end

  defp ensure_memory do
    case Process.whereis(WorkingMemory) do
      nil -> start_supervised!(WorkingMemory)
      _pid -> :ok
    end
  end
end
