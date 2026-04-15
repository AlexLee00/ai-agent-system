defmodule TeamJay.Investment.Phase5PersistenceSuite do
  @moduledoc """
  Phase 5 persistence 레일을 한 번에 점검하는 상위 suite.

  full scaffold 결과와 실제 DB row count를 같이 묶어
  Phase 5 materialization 상태를 한 장으로 확인한다.
  """

  alias Ecto.Adapters.SQL
  alias TeamJay.Investment.Phase5FullSuite
  alias TeamJay.Repo

  @tables [
    {:runtime_overrides, "5.5-4 runtime overrides", "investment.runtime_overrides"},
    {:circuit_breaker_events, "5.5-5 circuit breaker", "investment.circuit_breaker_events"},
    {:agent_memory_snapshots, "5-D agent memory", "investment.agent_memory_snapshots"},
    {:reflections, "5-D reflections", "investment.reflections"},
    {:market_modes, "5-E market modes", "investment.market_modes"},
    {:strategy_profiles, "5-E strategy profiles", "investment.strategy_profiles"},
    {:resource_feedback_events, "5.5-8 resource feedback", "investment.resource_feedback_events"},
    {:autonomous_cycle_events, "5.5-9 autonomous cycles", "investment.autonomous_cycle_events"},
    {:resource_health_events, "health snapshots", "investment.resource_health_events"}
  ]

  def run_defaults(opts \\ []) do
    full = Phase5FullSuite.run_defaults(opts)

    rows =
      Enum.map(@tables, fn {key, label, table_name} ->
        {row_count, symbol_count} = fetch_counts(table_name)

        %{
          key: key,
          label: label,
          table: table_name,
          row_count: row_count,
          symbol_count: symbol_count,
          status: status_for(row_count, symbol_count)
        }
      end)

    %{
      total: length(rows),
      passed: Enum.count(rows, &(&1.status == :ok)),
      failed: Enum.count(rows, &(&1.status != :ok)),
      all_ok: full.all_ok and Enum.all?(rows, &(&1.status == :ok)),
      full: full,
      rows: rows
    }
  end

  defp fetch_counts(table_name) do
    case SQL.query(Repo, "select count(*), count(distinct symbol) from #{table_name}", []) do
      {:ok, %{rows: [[row_count, symbol_count]]}} ->
        {row_count, symbol_count}

      _ ->
        {0, 0}
    end
  end

  defp status_for(row_count, symbol_count) when row_count > 0 and symbol_count > 0, do: :ok
  defp status_for(_row_count, _symbol_count), do: :check
end
