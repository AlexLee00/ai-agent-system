defmodule Luna.V2.Agents.SentinelTest do
  use ExUnit.Case, async: false

  alias Luna.V2.Agents.Sentinel
  alias Luna.V2.Memory.WorkingMemory

  setup do
    ensure_memory()
    :ok
  end

  test "inspect classifies anomaly severity without mutation" do
    result = Sentinel.inspect(%{error_count: 1, latency_ms: 12_000, reconcile_blockers: 1})
    assert result.agent == "sentinel"
    assert result.shadow == true
    assert result.mutate == false
    assert result.severity == :critical
    assert :manual_reconcile_blocker in result.findings
  end

  test "GenServer tick writes latest snapshot to working memory" do
    name = :"sentinel_test_#{System.unique_integer([:positive])}"
    start_supervised!({Sentinel, name: name, auto_tick: false})
    result = Sentinel.tick(name, %{auth_failures: 1})
    assert result.severity == :critical
    assert {:ok, memory} = WorkingMemory.get("agent:sentinel:latest")
    assert memory.agent == "sentinel"
  end

  defp ensure_memory do
    case Process.whereis(WorkingMemory) do
      nil -> start_supervised!(WorkingMemory)
      _pid -> :ok
    end
  end
end
