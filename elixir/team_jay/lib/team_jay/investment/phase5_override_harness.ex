defmodule TeamJay.Investment.Phase5OverrideHarness do
  @moduledoc """
  Phase 5.5-4 런타임 오버라이드 scaffold가 runtime_override snapshot까지 도달하는지 확인하는 harness.
  """

  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PipelineStarter
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.RuntimeOverrideStore
  alias TeamJay.Investment.Topics

  @default_timeout 6_000

  def run_once(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)
    inject_update = Keyword.get(opts, :inject_update)

    ensure_dynamic_supervisor!()
    topics = [Topics.strategy_updates(symbol), Topics.runtime_overrides(symbol)]
    Enum.each(topics, &PubSub.subscribe/1)

    started =
      case PipelineStarter.start_pipeline(exchange: exchange, symbol: symbol, interval_ms: interval_ms) do
        {:ok, pid} -> {:ok, pid}
        {:error, {:already_started, pid}} -> {:ok, pid}
        other -> other
      end

    result =
      case started do
        {:ok, _pid} ->
          maybe_inject_update(symbol, inject_update)

          symbol
          |> collect(timeout_ms, [], inject_update)
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

  defp collect(symbol, timeout_ms, events, inject_update) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    loop(symbol, deadline, events, inject_update)
  end

  defp loop(symbol, deadline, events, inject_update) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:investment_event, topic, payload} ->
        updated = [%{topic: topic, payload: payload} | events]

        if terminal_override_event?(topic, payload, symbol, inject_update) do
          %{
            status: :ok,
            completed: true,
            event_count: length(updated),
            events: Enum.reverse(updated),
            last_topic: topic
          }
        else
          loop(symbol, deadline, updated, inject_update)
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

  defp attach_store_status(result, symbol) do
    store_status = RuntimeOverrideStore.status(symbol)

    Map.merge(result, %{
      persisted_count: store_status.persisted_count,
      persist_status: store_status.last_persist_status,
      last_persisted_at: store_status.last_persisted_at
    })
  end

  defp maybe_inject_update(_symbol, nil), do: :ok

  defp maybe_inject_update(symbol, attrs) when is_map(attrs) do
    update =
      Events.strategy_update(symbol,
        governance_tier: Map.get(attrs, :governance_tier, :allow),
        action: Map.get(attrs, :action, :adjust_position_size),
        reason: Map.get(attrs, :reason, :persistence_smoke),
        proposals:
          Map.get(attrs, :proposals, %{
            position_size_delta: -0.05,
            tp_pct_delta: 0.005
          })
      )

    PubSub.broadcast_strategy_update(symbol, {:strategy_update, update})
  end

  defp terminal_override_event?(topic, {:runtime_override, _payload}, symbol, nil),
    do: topic == Topics.runtime_overrides(symbol)

  defp terminal_override_event?(topic, {:runtime_override, payload}, symbol, _inject_update) do
    topic == Topics.runtime_overrides(symbol) and
      get_in(payload, [:persistence, :inserted_count]) |> Kernel.>(0)
  end

  defp terminal_override_event?(_topic, _payload, _symbol, _inject_update), do: false
end
