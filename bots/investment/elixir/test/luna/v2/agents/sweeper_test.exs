defmodule Luna.V2.Agents.SweeperTest do
  use ExUnit.Case, async: false

  alias Luna.V2.Agents.Sweeper
  alias Luna.V2.Memory.WorkingMemory

  setup do
    ensure_memory()
    :ok
  end

  test "compare classifies in-sync and wallet-only dust" do
    synced = Sweeper.compare(%{quantity: 1.0}, %{quantity: 1.0, mark_price: 10.0})
    assert synced.state == :in_sync
    assert synced.mutate == false

    dust = Sweeper.compare(%{quantity: 0.0}, %{quantity: 0.001, mark_price: 100.0})
    assert dust.state == :wallet_only_dust
    assert dust.action_plan == :observe_or_manual_dust_sync
  end

  test "GenServer tick writes latest snapshot to working memory" do
    name = :"sweeper_test_#{System.unique_integer([:positive])}"
    start_supervised!({Sweeper, name: name, auto_tick: false})
    result = Sweeper.tick(name, %{quantity: 1.0}, %{quantity: 0.0, mark_price: 10.0})
    assert result.state == :external_close_suspected
    assert {:ok, memory} = WorkingMemory.get("agent:sweeper:latest")
    assert memory.agent == "sweeper"
  end

  defp ensure_memory do
    case Process.whereis(WorkingMemory) do
      nil -> start_supervised!(WorkingMemory)
      _pid -> :ok
    end
  end
end
