defmodule TeamJay.Investment.Execution.Worker do
  @moduledoc """
  투자팀 실행 GenServer 스캐폴드.

  approved_signal 이벤트를 받아 실행 결과 이벤트를 발행한다. 현재는 실제
  브로커 호출 없이 execution scaffold result만 남긴다.
  """

  use GenServer

  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_execution, symbol}}}

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _ref} = PubSub.subscribe(Topics.approved_signal(symbol))

    {:ok,
     %{
       symbol: symbol,
       executed_count: 0,
       last_execution_at: nil
     }}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:approved_signal, approved_signal}}, state) do
    trade_result = %{
      symbol: state.symbol,
      source: :execution_scaffold,
      executed: true,
      executed_at: DateTime.utc_now(),
      approved_signal: approved_signal
    }

    PubSub.broadcast(Topics.trade_result(state.symbol), {:trade_result, trade_result})

    {:noreply,
     %{state | executed_count: state.executed_count + 1, last_execution_at: trade_result.executed_at}}
  end
end
