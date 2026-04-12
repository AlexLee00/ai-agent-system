defmodule TeamJay.Investment.PipelineHarness do
  @moduledoc """
  투자팀 Elixir scaffold 파이프라인의 로컬 연결성을 확인하는 테스트용 harness.

  운영 메인 경로와 분리해서 단일 심볼 pipeline을 띄우고,
  feedback 이벤트까지 도달하는지 확인하는 용도다.
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
      Topics.analysis(symbol),
      Topics.signal(symbol),
      Topics.approved_signal(symbol),
      Topics.trade_result(symbol),
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
        {:ok, _pid} ->
          collect_events(symbol, timeout_ms)

        error ->
          %{status: :failed_to_start, error: inspect(error), events: []}
      end

    _ = PipelineStarter.stop_pipeline(exchange, symbol)
    Enum.each(topics, &PubSub.unsubscribe/1)

    Map.merge(
      %{
        exchange: exchange,
        symbol: symbol,
        timeout_ms: timeout_ms
      },
      result
    )
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

  defp collect_events(symbol, timeout_ms) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    loop_collect(symbol, deadline, [])
  end

  defp loop_collect(symbol, deadline, events) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:investment_event, topic, payload} ->
        event = %{topic: topic, payload: payload}
        updated = [event | events]

        if topic == Topics.feedback(symbol) do
          %{
            status: :ok,
            completed: true,
            events: Enum.reverse(updated),
            event_count: length(updated)
          }
        else
          loop_collect(symbol, deadline, updated)
        end
    after
      remaining ->
        %{
          status: :timeout,
          completed: false,
          events: Enum.reverse(events),
          event_count: length(events)
        }
    end
  end
end
