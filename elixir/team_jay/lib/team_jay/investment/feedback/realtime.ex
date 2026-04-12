defmodule TeamJay.Investment.Feedback.Realtime do
  @moduledoc """
  투자팀 실시간 피드백 GenServer 스캐폴드.

  trade_result 이벤트를 받아 포지션 추적과 즉시 평가가 들어갈 위치를 고정한다.
  현재는 entry/exit 이벤트를 구분해 scaffold feedback 이벤트만 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Feedback.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_feedback_realtime, symbol}}}

  def status(symbol) do
    GenServer.call(via(symbol), :status)
  end

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.trade_result(symbol))

    {:ok,
     %{
       symbol: symbol,
       open_positions: %{},
       feedback_count: 0,
       last_feedback_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       feedback_count: state.feedback_count,
       last_feedback_at: state.last_feedback_at,
       open_position_count: map_size(state.open_positions),
       open_positions: Map.keys(state.open_positions)
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:trade_result, result}}, state) do
    {feedback, open_positions} = build_feedback(result, state)

    PubSub.broadcast(Topics.feedback(state.symbol), {:feedback, feedback})

    {:noreply,
     %{
       state
       | open_positions: open_positions,
         feedback_count: state.feedback_count + 1,
         last_feedback_at: feedback.generated_at
     }}
  end

  defp build_feedback(result, state) do
    action = infer_trade_action(result)

    feedback =
      Events.realtime(state.symbol,
        action: action,
        evaluation: scaffold_evaluation(action),
        trade_result: result
      )

    open_positions =
      case action do
        :entry -> Map.put(state.open_positions, position_key(result), result)
        :exit -> Map.delete(state.open_positions, position_key(result))
        _other -> state.open_positions
      end

    {feedback, open_positions}
  end

  defp infer_trade_action(result) when is_map(result) do
    cond do
      result[:action] in [:entry, "entry"] -> :entry
      result[:action] in [:exit, "exit"] -> :exit
      result[:executed] == true -> :execution
      true -> :observe
    end
  end

  defp scaffold_evaluation(:entry), do: %{status: :tracking_started, score: 0.0}
  defp scaffold_evaluation(:exit), do: %{status: :evaluated, score: 0.0}
  defp scaffold_evaluation(_other), do: %{status: :observed, score: 0.0}

  defp position_key(result) do
    result[:symbol] || result["symbol"]
  end
end
