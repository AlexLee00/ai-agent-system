defmodule TeamJay.Investment.Phase5AutonomyHarness do
  @moduledoc """
  Phase 5.5-9 완전자율 연속 루프 coordinator가 autonomous_cycle까지 도달하는지 확인하는 harness.
  """

  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.PipelineStarter
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.ContinuousLoopCoordinator
  alias TeamJay.Investment.Topics

  @default_timeout 6_000

  def run_once(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)
    release_wait_ms = Keyword.get(opts, :release_wait_ms, 25)

    ensure_dynamic_supervisor!()
    topics = [Topics.autonomous_cycles(symbol)]
    Enum.each(topics, &PubSub.subscribe/1)

    started =
      case PipelineStarter.start_pipeline(
             exchange: exchange,
             symbol: symbol,
             interval_ms: interval_ms,
             circuit_release_wait_ms: release_wait_ms
           ) do
        {:ok, pid} -> {:ok, pid}
        {:error, {:already_started, pid}} -> {:ok, pid}
        other -> other
      end

    result =
      case started do
        {:ok, _pid} ->
          symbol
          |> collect(timeout_ms, [])
          |> attach_store_status(symbol)

        error -> %{status: :failed_to_start, completed: false, error: inspect(error), events: []}
      end

    _ = PipelineStarter.stop_pipeline(exchange, symbol)
    Enum.each(topics, &PubSub.unsubscribe/1)

    Map.merge(%{exchange: exchange, symbol: symbol, timeout_ms: timeout_ms}, result)
  end

  defp ensure_dynamic_supervisor! do
    case Process.whereis(TeamJay.Investment.PipelineDynamicSupervisor) do
      nil ->
        {:ok, _pid} = PipelineDynamicSupervisor.start_link([])
        :ok

      _pid ->
        :ok
    end
  end

  defp collect(symbol, timeout_ms, events) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    loop(symbol, deadline, events)
  end

  defp attach_store_status(result, symbol) do
    autonomy_status = ContinuousLoopCoordinator.status(symbol)

    Map.merge(result, %{
      persisted_count: Map.get(autonomy_status, :persisted_count, 0),
      persist_status: Map.get(autonomy_status, :last_persist_status, :idle),
      last_persisted_at: Map.get(autonomy_status, :last_persisted_at)
    })
  end

  defp loop(symbol, deadline, events) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:investment_event, topic, payload} ->
        updated = [%{topic: topic, payload: payload} | events]

        if topic == Topics.autonomous_cycles(symbol) do
          %{
            status: :ok,
            completed: true,
            event_count: length(updated),
            events: Enum.reverse(updated),
            last_topic: topic
          }
        else
          loop(symbol, deadline, updated)
        end
    after
      remaining ->
        %{
          status: :timeout,
          completed: false,
          event_count: length(events),
          events: Enum.reverse(events),
          last_topic: events |> List.first() |> then(&(&1 && &1.topic))
        }
    end
  end
end
