defmodule TeamJay.Investment.Phase5CircuitHarness do
  @moduledoc """
  Phase 5.5-5 서킷 브레이커 scaffold가
  warning -> paper -> live_release 흐름까지 도달하는지 확인하는 harness.
  """

  alias TeamJay.Investment.CircuitBreaker
  alias TeamJay.Investment.Events
  alias TeamJay.Investment.Feedback.Events, as: FeedbackEvents
  alias TeamJay.Investment.PipelineDynamicSupervisor
  alias TeamJay.Investment.PipelineStarter
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_timeout 6_000

  def run_once(opts \\ []) do
    exchange = Keyword.get(opts, :exchange, "binance")
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    interval_ms = Keyword.get(opts, :interval_ms, 150)
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)
    release_wait_ms = Keyword.get(opts, :release_wait_ms, 25)

    ensure_dynamic_supervisor!()

    topics = [Topics.circuit_breakers(symbol)]
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
          seed_sequence(symbol, release_wait_ms)
          collect(symbol, timeout_ms, [])

        error ->
          %{status: :failed_to_start, completed: false, error: inspect(error), events: []}
      end

    circuit_status =
      case CircuitBreaker.status(symbol) do
        status when is_map(status) -> status
        _other -> %{}
      end

    _ = PipelineStarter.stop_pipeline(exchange, symbol)
    Enum.each(topics, &PubSub.unsubscribe/1)

    Map.merge(
      %{exchange: exchange, symbol: symbol, timeout_ms: timeout_ms, circuit_status: circuit_status},
      result
    )
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

  defp seed_sequence(symbol, release_wait_ms) do
    PubSub.broadcast_market_mode(
      symbol,
      {:market_mode, Events.market_mode(symbol, mode: :swing, horizon: :mid_term)}
    )

    Enum.each(1..3, fn _ ->
      emit_feedback(symbol, :loss)
      Process.sleep(5)
    end)

    Process.sleep(release_wait_ms + 10)

    Enum.each(1..3, fn _ ->
      emit_feedback(symbol, :win)
      Process.sleep(5)
    end)
  end

  defp emit_feedback(symbol, outcome) do
    score = if outcome == :win, do: 0.8, else: -0.8

    feedback =
      FeedbackEvents.realtime(symbol,
        action: :exit,
        outcome: outcome,
        evaluation: %{status: :evaluated, score: score}
      )

    PubSub.broadcast(Topics.feedback(symbol), {:feedback, feedback})
  end

  defp collect(symbol, timeout_ms, events) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    loop(symbol, deadline, events, %{warn?: false, paper?: false, released?: false})
  end

  defp loop(symbol, deadline, events, flags) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:investment_event, topic, {:circuit_breaker, payload}} ->
        updated = [%{topic: topic, payload: payload} | events]
        next_flags = update_flags(flags, payload)

        if topic == Topics.circuit_breakers(symbol) and next_flags.warn? and next_flags.paper? and next_flags.released? do
          %{
            status: :ok,
            completed: true,
            event_count: length(updated),
            events: Enum.reverse(updated),
            last_topic: topic
          }
        else
          loop(symbol, deadline, updated, next_flags)
        end

      {:investment_event, topic, payload} ->
        updated = [%{topic: topic, payload: payload} | events]
        loop(symbol, deadline, updated, flags)
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

  defp update_flags(flags, %{level: 1}), do: %{flags | warn?: true}
  defp update_flags(flags, %{level: 2, paper_mode: true}), do: %{flags | paper?: true}
  defp update_flags(flags, %{level: 0, paper_mode: false, release_ready: false}), do: %{flags | released?: true}
  defp update_flags(flags, _payload), do: flags
end
