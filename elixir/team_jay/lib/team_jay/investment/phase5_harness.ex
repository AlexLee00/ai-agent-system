defmodule TeamJay.Investment.Phase5Harness do
  @moduledoc """
  Phase 5-A 실시간 포지션 관리 scaffold 연결성 harness.

  단일 심볼 pipeline을 띄우고 price_tick -> position_state -> condition_check 흐름이
  feedback 이후까지 이어지는지 확인한다.
  """

  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.PipelineStarter
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_timeout 6_000

  def run_once(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, 250)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)

    ensure_dynamic_supervisor!()

    topics = [
      Topics.trade_result(symbol),
      Topics.price_ticks(symbol),
      Topics.position_state(symbol),
      Topics.condition_checks(symbol),
      Topics.feedback(symbol)
    ]

    Enum.each(topics, &PubSub.subscribe/1)

    started =
      case PipelineStarter.start_pipeline(exchange: exchange, symbol: symbol, interval_ms: interval_ms) do
        {:ok, pid} -> {:ok, pid}
        {:error, {:already_started, pid}} -> {:ok, pid}
        other -> other
      end

    result =
      case started do
        {:ok, _pid} -> collect(symbol, timeout_ms, [])
        error -> %{status: :failed_to_start, completed: false, error: inspect(error), events: []}
      end

    _ = PipelineStarter.stop_pipeline(exchange, symbol)
    Enum.each(topics, &PubSub.unsubscribe/1)

    Map.merge(%{exchange: exchange, symbol: symbol, timeout_ms: timeout_ms}, result)
  end

  defp ensure_dynamic_supervisor! do
    case Process.whereis(PipelineDynamicSupervisor) do
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

  defp loop(symbol, deadline, events) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:investment_event, topic, payload} ->
        updated = [%{topic: topic, payload: payload} | events]

        if complete?(symbol, updated) do
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

  defp complete?(symbol, events) do
    topics = Enum.map(events, & &1.topic)

    Enum.all?(
      [
        Topics.trade_result(symbol),
        Topics.price_ticks(symbol),
        Topics.position_state(symbol),
        Topics.condition_checks(symbol),
        Topics.feedback(symbol)
      ],
      &Enum.member?(topics, &1)
    )
  end
end
