defmodule TeamJay.Investment.Feedback.Harness do
  @moduledoc """
  투자팀 realtime feedback scaffold의 로컬 동작을 확인하는 harness.

  synthetic trade_result 이벤트를 넣어서 feedback 이벤트와 내부 상태 변화가
  기대대로 나오는지 확인한다.
  """

  alias TeamJay.Investment.Feedback.Realtime
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_timeout 1_500

  def run_once(opts \\ []) do
    symbol = Keyword.get(opts, :symbol, "BTC/USDT")
    timeout_ms = Keyword.get(opts, :timeout_ms, @default_timeout)

    started = ensure_feedback_worker(symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.feedback(symbol))

    entry_result = trade_result(symbol, :entry, "BUY")
    PubSub.broadcast(Topics.trade_result(symbol), {:trade_result, entry_result})
    entry_feedback = await_feedback(symbol, timeout_ms)
    entry_status = Realtime.status(symbol)

    exit_result = trade_result(symbol, :exit, "SELL")
    PubSub.broadcast(Topics.trade_result(symbol), {:trade_result, exit_result})
    exit_feedback = await_feedback(symbol, timeout_ms)
    exit_status = Realtime.status(symbol)

    PubSub.unsubscribe(Topics.feedback(symbol))
    cleanup_feedback_worker(symbol, started)

    %{
      symbol: symbol,
      start_result: started,
      entry_feedback: entry_feedback,
      entry_status: entry_status,
      exit_feedback: exit_feedback,
      exit_status: exit_status
    }
  end

  defp ensure_feedback_worker(symbol) do
    case Registry.lookup(TeamJay.AgentRegistry, {:investment_feedback_realtime, symbol}) do
      [{pid, _meta}] ->
        %{status: :already_started, pid: inspect(pid)}

      [] ->
        case Realtime.start_link(symbol: symbol) do
          {:ok, pid} -> %{status: :started, pid: inspect(pid)}
          {:error, {:already_started, pid}} -> %{status: :already_started, pid: inspect(pid)}
          other -> %{status: :failed_to_start, error: inspect(other)}
        end
    end
  end

  defp cleanup_feedback_worker(_symbol, %{status: :already_started}), do: :ok

  defp cleanup_feedback_worker(symbol, %{status: :started}) do
    case Registry.lookup(TeamJay.AgentRegistry, {:investment_feedback_realtime, symbol}) do
      [{pid, _meta}] -> GenServer.stop(pid, :normal)
      [] -> :ok
    end
  end

  defp cleanup_feedback_worker(_symbol, _other), do: :ok

  defp await_feedback(symbol, timeout_ms) do
    feedback_topic = Topics.feedback(symbol)

    receive do
      {:investment_event, topic, {:feedback, payload}} when topic == feedback_topic ->
        %{status: :ok, topic: topic, payload: payload}
    after
      timeout_ms ->
        %{status: :timeout}
    end
  end

  defp trade_result(symbol, action, side) do
    %{
      symbol: symbol,
      action: action,
      side: side,
      executed: true,
      generated_at: DateTime.utc_now()
    }
  end
end
